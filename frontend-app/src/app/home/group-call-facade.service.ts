import {Injectable, OnDestroy} from '@angular/core';
import {BehaviorSubject, Subscription} from 'rxjs';
import {CallSignal, DataProviderService, GroupCallParticipant, GroupCallRoomEventPayload, GroupCallRoomPayload, GroupCallRoomSocketEvent, GroupCallSignalSocketEvent, GroupCallSyncedSocketEvent, ICEServer, isGroupRoomEventPayload, MessageSocketEvent} from './data-provider.service';
import {createRandomID} from '../login/login';

export type GroupCallPhase = 'idle' | 'requesting' | 'ringing' | 'joining' | 'active' | 'left' | 'ended' | 'error';
export type GroupScreenQuality = '360p' | '720p' | '1080p' | '2k';
export interface GroupCallPeer { readonly userID: string; readonly deviceID: string; readonly stream?: MediaStream; readonly presentation?: MediaStream; }
export interface GroupCallState {
    readonly phase: GroupCallPhase;
    /** Conversation owning a short-lived terminal notice, even after room teardown. */
    readonly conversationID?: string;
    readonly room?: GroupCallRoomPayload;
    readonly localStream?: MediaStream;
    readonly peers: readonly GroupCallPeer[];
    readonly muted: boolean;
    readonly presentation?: MediaStream;
    readonly remotePresentation?: MediaStream;
    readonly sharing: boolean;
    readonly screenShareAudioEnabled: boolean;
    readonly screenShareAudioActive: boolean;
    readonly shareTransitioning: boolean;
    readonly inputDevices: readonly MediaDeviceInfo[];
    readonly outputDevices: readonly MediaDeviceInfo[];
    readonly selectedInputID?: string;
    readonly selectedOutputID?: string;
    readonly audioPlaybackBlocked: boolean;
    readonly statusLabel: string;
    readonly errorLabel?: string;
}

const idleState: GroupCallState = Object.freeze({phase: 'idle', peers: [], muted: false, sharing: false, screenShareAudioEnabled: false, screenShareAudioActive: false, shareTransitioning: false, inputDevices: [], outputDevices: [], audioPlaybackBlocked: false, statusLabel: 'No active group call.'});

interface PeerConnectionState {
    readonly connection: RTCPeerConnection;
    readonly generation: number;
    remoteDescriptionReady: boolean;
    readonly candidates: RTCIceCandidateInit[];
}

interface RemotePresentationReceiver {
    readonly connection: PeerConnectionState;
    readonly generation: number;
    readonly roomID: string;
    readonly roomGeneration: number;
    readonly stream: MediaStream;
    readonly track: MediaStreamTrack;
}

interface LocalPresentationCapture {
    readonly stream: MediaStream;
    readonly videoTrack: MediaStreamTrack;
    readonly audioTrack?: MediaStreamTrack;
    readonly generation: number;
    startup: boolean;
    active: boolean;
    videoEnded: boolean;
    audioEnded: boolean;
    audioStopping: boolean;
    stopping: boolean;
    stopPromise?: Promise<void>;
}

interface AudioOutputSink {
    setSinkId(deviceID: string): Promise<void>;
}

type GroupCallControlType = 'group.call.leave' | 'group.call.end';
interface PendingGroupCallControl {
    readonly requestID: string;
    readonly type: GroupCallControlType;
    readonly room: GroupCallRoomPayload;
    readonly baselineRevision: number;
    readonly localGeneration: number;
    readonly userID: string;
    readonly deviceID: string;
}
interface PendingControlReconciliation extends PendingGroupCallControl {
    readonly syncRequestID: string;
    readonly hasAdvancedRevision: boolean;
}

@Injectable()
export class GroupCallFacade implements OnDestroy {
    private readonly stateSubject = new BehaviorSubject<GroupCallState>(idleState);
    private readonly subscription: Subscription;
    private readonly connections = new Map<string, PeerConnectionState>();
    private readonly pendingSignals = new Map<string, CallSignal[]>();
    private readonly mediaSenders = new Map<string, RTCRtpSender>();
    private readonly presentationSenders = new Map<string, RTCRtpSender>();
    private readonly presentationAudioSenders = new Map<string, RTCRtpSender>();
    private readonly remotePresentationReceivers = new Map<string, RemotePresentationReceiver>();
    private presentationCapture?: LocalPresentationCapture;
    private readonly retiredRoomIDs = new Set<string>();
    private rejoinableRoom?: GroupCallRoomPayload;
    private rejoinableStateRevision = -1;
    private generation = 0;
    private selfID?: string;
    private conversationID?: string;
    private dismissTimer?: number;
    private syncTimer?: number;
    private syncRequestTimeout?: number;
    private pendingSync?: {requestID: string; generation: number; roomID: string; roomGeneration: number};
    private pendingStartOrJoin?: {requestID: string; generation: number};
    private pendingDiscovery?: {requestID: string; generation: number; conversationID: string; selfID: string};
    private discoveryTimeout?: number;
    private screenShareAudioEnabled = false;
    private pendingControl?: PendingGroupCallControl;
    private pendingControlReconciliation?: PendingControlReconciliation;
    private controlSyncTimeout?: number;
    private controlStateUncertain = false;
    private lastAppliedStateRevision = -1;
    private deviceListener?: () => void;
    private readonly remoteAudios = new Set<HTMLAudioElement>();
    private readonly playbackRequestedAudios = new Set<HTMLAudioElement>();
    private presentationOperationQueue: Promise<void> = Promise.resolve();
    public readonly state$ = this.stateSubject.asObservable();

    public constructor(private readonly dataProvider: DataProviderService) {
        this.subscription = this.dataProvider.getObservable().subscribe(event => this.handleEvent(event));
        this.subscription.add(this.dataProvider.readyChanges.subscribe(ready => {
            if (!ready && (this.isOngoing || this.state.phase === 'left')) this.handleDisconnect();
            else if (ready) this.startSyncLoop();
        }));
    }
    public get state(): GroupCallState { return this.stateSubject.value; }
    public get isOngoing(): boolean { return ['ringing', 'joining', 'active'].includes(this.state.phase); }
    public canRejoin(conversationID: string): boolean { return (this.state.phase === 'left' || this.state.phase === 'idle') && !this.pendingControlReconciliation && !this.controlStateUncertain && this.rejoinableRoom?.conversation_id === conversationID; }

    public async start(conversationID: string, selfID: string): Promise<void> {
        if (!this.canStart()) return;
        const generation = this.beginGeneration(selfID, conversationID);
        this.rejoinableRoom = undefined;
        this.rejoinableStateRevision = -1;
        this.setState({...idleState, phase: 'requesting', statusLabel: 'Requesting microphone access...'});
        const stream = await this.microphone(generation);
        if (!stream || !this.current(generation)) return;
        this.setState({...this.state, phase: 'ringing', localStream: stream, statusLabel: 'Starting group call...'});
        const requestID = createRandomID();
        this.pendingStartOrJoin = {requestID, generation};
        if (!this.send({type: 'group.call.start', request_id: requestID, payload: {conversation_id: conversationID}}, generation)) {
            this.pendingStartOrJoin = undefined;
            this.stop(stream);
            return;
        }
    }

    /** Discover first so only an authorized, current room can be joined. */
    public discoverAndStart(conversationID: string, selfID: string): void {
        if (!this.canStart() || this.pendingDiscovery || !this.dataProvider.ready) return;
        const generation = this.beginGeneration(selfID, conversationID);
        this.setState({...idleState, phase: 'requesting', statusLabel: 'Checking for an active group call…'});
        const requestID = createRandomID();
        this.pendingDiscovery = {requestID, generation, conversationID, selfID};
        this.discoveryTimeout = window.setTimeout(() => {
            if (this.pendingDiscovery?.requestID !== requestID) return;
            this.pendingDiscovery = undefined;
            this.discoveryTimeout = undefined;
            this.fail('Checking for an active group call timed out. Try again.');
        }, 8_000);
        if (!this.send({type: 'group.call.discover', request_id: requestID, payload: {conversation_id: conversationID}}, generation)) {
            this.pendingDiscovery = undefined;
            this.fail('Could not check for an active group call. Try again.');
        }
    }

    public async join(room: GroupCallRoomPayload, selfID: string): Promise<void> {
        if (!this.canStart() || room.status === 'ended' || !isPositiveGeneration(room.generation)) return;
        const rejoinRevision = this.state.phase === 'left' && this.rejoinableRoom?.room_id === room.room_id && this.rejoinableRoom.generation === room.generation
            ? this.rejoinableStateRevision
            : -1;
        const generation = this.beginGeneration(selfID, room.conversation_id);
        this.lastAppliedStateRevision = 'state_revision' in room && typeof room.state_revision === 'number' ? room.state_revision : rejoinRevision;
        this.setState({...idleState, phase: 'requesting', room, statusLabel: 'Requesting microphone access...'});
        const stream = await this.microphone(generation);
        if (!stream || !this.current(generation)) return;
        this.setState({...this.state, phase: 'joining', room, localStream: stream, statusLabel: 'Joining group call...'});
        const requestID = createRandomID();
        this.pendingStartOrJoin = {requestID, generation};
        if (!this.send({type: 'group.call.join', request_id: requestID, payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, generation)) {
            this.pendingStartOrJoin = undefined;
            this.stop(stream);
            return;
        }
    }

    public leave(): void {
        const room = this.state.room;
        if (!room || !isPositiveGeneration(room.generation) || this.pendingControl) return;
        const localStream = this.state.localStream;
        const userID = this.selfID || '';
        const deviceID = room.participants.find(participant => participant.user_id === userID)?.device_id || '';
        const requestID = createRandomID();
        if (!this.send({type: 'group.call.leave', request_id: requestID, payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, this.generation)) return;
        const revision = this.lastAppliedStateRevision;
        this.terminal('You left the group call.', false);
        this.pendingControl = {requestID, type: 'group.call.leave', room, baselineRevision: revision, localGeneration: this.generation, userID, deviceID};
        if (localStream) this.stop(localStream);
        if (room.participants.length > 1) {
            this.rejoinableRoom = room;
            this.rejoinableStateRevision = revision;
            this.setState({...idleState, phase: 'left', conversationID: room.conversation_id, statusLabel: 'You left the group call.'});
        }
        this.dismissTerminalNoticeSoon();
    }
    public rejoin(selfID: string): void {
        if (this.pendingControlReconciliation) return;
        const room = this.rejoinableRoom;
        if (room && (this.state.phase === 'left' || this.state.phase === 'idle')) void this.join(room, selfID);
    }
    public end(): void {
        const room = this.state.room;
        if (!room || !isPositiveGeneration(room.generation)) { this.terminal('Group call ended.'); return; }
        if (this.pendingControl) return;
        const requestID = createRandomID();
        const baselineRevision = this.lastAppliedStateRevision;
        const userID = this.selfID || '';
        const deviceID = room.participants.find(participant => participant.user_id === userID)?.device_id || '';
        if (!this.send({type: 'group.call.end', request_id: requestID, payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, this.generation)) return;
        this.terminal('Group call ended.');
        this.pendingControl = {requestID, type: 'group.call.end', room, baselineRevision, localGeneration: this.generation, userID, deviceID};
    }
    /** Stops local group-call work for a removed conversation without signaling other members. */
    public abort(conversationID: string): boolean {
        if (this.conversationID !== conversationID && this.state.room?.conversation_id !== conversationID && this.rejoinableRoom?.conversation_id !== conversationID) return false;
        this.terminal('Group call ended.', false);
        this.setState(idleState);
        return true;
    }
    /** Explicitly starts a rendered remote audio element after its stream is attached. */
    public playRemoteAudio(audio: HTMLAudioElement): void {
        this.remoteAudios.add(audio);
        if (this.playbackRequestedAudios.has(audio)) return;
        this.playbackRequestedAudios.add(audio);
        const selectedOutputID = this.state.selectedOutputID;
        if (selectedOutputID) void this.applyOutputDevice(audio, selectedOutputID);
        void this.tryPlayRemoteAudio(audio, this.generation);
    }
    public registerRemoteAudio(audio: HTMLAudioElement): void {
        this.remoteAudios.add(audio);
        // Readiness events can run before Angular registers a recreated view.
        // Treat registration as a fresh attachment so the current srcObject gets
        // a playback attempt even if this element was touched before registration.
        this.playbackRequestedAudios.delete(audio);
        this.playRemoteAudio(audio);
    }
    /** Releases an audio element when Angular removes its owning view. */
    public unregisterRemoteAudio(audio: HTMLAudioElement): void {
        if (!this.remoteAudios.delete(audio)) return;
        this.playbackRequestedAudios.delete(audio);
        audio.pause();
        audio.srcObject = null;
    }
    public enableRemoteAudio(): void {
        const generation = this.generation;
        for (const audio of this.remoteAudios) void this.tryPlayRemoteAudio(audio, generation);
    }
    public toggleMute(): void {
        const stream = this.state.localStream;
        if (!stream) return;
        const muted = !this.state.muted;
        stream.getAudioTracks().forEach(track => track.enabled = !muted);
        this.setState({...this.state, muted, statusLabel: muted ? 'Microphone muted.' : 'Microphone on.'});
    }
    public async selectInputDevice(deviceID: string): Promise<void> {
        const generation = this.generation;
        if (!this.state.localStream || !this.current(generation)) return;
        let replacement: MediaStream | undefined;
        try {
            replacement = await navigator.mediaDevices.getUserMedia({audio: {deviceId: {exact: deviceID}}});
            if (!this.current(generation)) { this.stop(replacement); return; }
            const track = replacement.getAudioTracks()[0];
            if (!track) { this.stop(replacement); return; }
            // replaceTrack does not inherit the previous track's enabled state.
            // Apply the call's mute state before any peer can send this track.
            track.enabled = !this.state.muted;
            const previousTrack = this.state.localStream.getAudioTracks()[0];
            const replaced: Array<[string, RTCRtpSender]> = [];
            try {
                for (const [key, sender] of this.mediaSenders) {
                    await this.replaceTrack(key, sender, track, generation);
                    replaced.push([key, sender]);
                }
            } catch (error: unknown) {
                // Keep the previous stream alive until every peer has switched. Restore
                // senders already updated so a failed selection cannot leave them using
                // a track that is stopped below.
                if (this.current(generation) && previousTrack && previousTrack.readyState !== 'ended') {
                    for (const [key, sender] of replaced.reverse()) {
                        await this.replaceTrack(key, sender, previousTrack, generation).catch(() => undefined);
                    }
                }
                throw error;
            }
            if (!this.current(generation)) { this.stop(replacement); return; }
            this.stop(this.state.localStream);
            this.setState({...this.state, localStream: replacement, selectedInputID: deviceID, statusLabel: 'Microphone changed.'});
        } catch {
            this.stop(replacement);
            if (this.current(generation)) this.setState({...this.state, statusLabel: 'The selected microphone is unavailable.', errorLabel: 'The selected microphone is unavailable.'});
        }
    }
    /** Applies the selected output to every rendered remote peer, not just the first peer. */
    public async selectOutputDevice(deviceID: string): Promise<void> {
        const audios = [...this.remoteAudios];
        if (!audios.length) {
            this.setState({...this.state, selectedOutputID: deviceID, statusLabel: 'Speaker changed.'});
            return;
        }
        const sinks = audios.map(audio => this.outputSink(audio));
        if (sinks.some(sink => !sink)) { this.setState({...this.state, statusLabel: 'Speaker selection is not supported by this browser.'}); return; }
        try {
            await Promise.all(sinks.map(sink => sink?.setSinkId(deviceID)));
            this.setState({...this.state, selectedOutputID: deviceID, statusLabel: 'Speaker changed.'});
        } catch {
            this.setState({...this.state, statusLabel: 'The selected speaker is unavailable.'});
        }
    }
    public startPresentation(quality: GroupScreenQuality): Promise<void> {
        return this.enqueuePresentationOperation(() => this.startPresentationNow(quality));
    }
    private async startPresentationNow(quality: GroupScreenQuality): Promise<void> {
        const room = this.state.room;
        const generation = this.generation;
        if (!room || !isPositiveGeneration(room.generation) || !this.state.localStream || this.state.shareTransitioning || this.presentationCapture || !this.current(generation)) return;
        this.setState({...this.state, shareTransitioning: true, statusLabel: 'Starting presentation...'});
        let capturedStream: MediaStream | undefined;
        let capture: LocalPresentationCapture | undefined;
        try {
            if (!this.send({type: 'group.call.presenter.start', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, generation)) return;
            capturedStream = await navigator.mediaDevices.getDisplayMedia({video: this.screenConstraints(quality), audio: this.screenShareAudioEnabled});
            if (!this.current(generation)) { this.stop(capturedStream); return; }
            const videoTrack = capturedStream.getVideoTracks()[0];
            if (!videoTrack || videoTrack.readyState !== 'live') {
                this.stop(capturedStream);
                this.send({type: 'group.call.presenter.stop', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, generation);
                this.setState({...this.state, shareTransitioning: false, statusLabel: 'No live screen was selected.'});
                return;
            }
            const audioTrack = capturedStream.getAudioTracks()[0];
            const localCapture: LocalPresentationCapture = {stream: capturedStream, videoTrack, audioTrack, generation, startup: true, active: false, videoEnded: false, audioEnded: audioTrack?.readyState !== 'live', audioStopping: false, stopping: false};
            capture = localCapture;
            this.presentationCapture = localCapture;
            // Install both listeners before the first sender operation/await. Some
            // browsers can end a display track while renegotiation is pending.
            videoTrack.addEventListener('ended', () => {
                if (this.presentationCapture !== localCapture || !this.current(generation)) return;
                localCapture.videoEnded = true;
                if (localCapture.active) void this.enqueuePresentationOperation(() => this.stopPresentationCapture(localCapture));
            }, {once: true});
            if (audioTrack) audioTrack.addEventListener('ended', () => {
                if (this.presentationCapture !== localCapture || !this.current(generation)) return;
                localCapture.audioEnded = true;
                if (localCapture.active) void this.enqueuePresentationOperation(() => this.stopPresentationAudio(localCapture));
            }, {once: true});
            this.assertPresentationVideoLive(capture);
            for (const [key, state] of this.connections) {
                this.assertPresentationVideoLive(capture);
                const sender = this.presentationSenders.get(key) || state.connection.addTrack(videoTrack, capturedStream);
                this.presentationSenders.set(key, sender);
                await this.replaceTrack(key, sender, videoTrack, generation);
                this.assertPresentationVideoLive(capture);
                if (audioTrack && !capture.audioEnded && audioTrack.readyState === 'live') {
                    const audioSender = this.presentationAudioSenders.get(key) || state.connection.addTrack(audioTrack, capturedStream);
                    this.presentationAudioSenders.set(key, audioSender);
                    await this.replaceTrack(key, audioSender, audioTrack, generation);
                    if (capture.audioEnded || audioTrack.readyState !== 'live') await this.replaceTrack(key, audioSender, null, generation);
                }
                await this.offerParticipant(key, state, generation);
                this.assertPresentationVideoLive(capture);
            }
            if (audioTrack && (capture.audioEnded || audioTrack.readyState !== 'live')) {
                capturedStream.removeTrack(audioTrack);
                for (const [key, sender] of this.presentationAudioSenders) {
                    await this.replaceTrack(key, sender, null, generation);
                    const peer = this.connections.get(key);
                    if (peer) await this.offerParticipant(key, peer, generation);
                }
            }
            this.assertPresentationVideoLive(capture);
            capture.startup = false;
            capture.active = true;
            const audioActive = Boolean(audioTrack && !capture.audioEnded && audioTrack.readyState === 'live');
            this.setState({...this.state, presentation: capturedStream, sharing: true, screenShareAudioActive: audioActive, shareTransitioning: false, statusLabel: this.screenShareAudioEnabled && !audioActive ? 'You are presenting. System audio was not available.' : 'You are presenting.'});
        } catch {
            if (capture) { capture.stopping = true; capture.active = false; }
            // A terminal transition can win while sender replacement/offer awaits
            // are outstanding. It cannot see a not-yet-published stream, so the
            // stale startup itself still owns and releases the captured tracks.
            this.stop(capturedStream);
            if (capture && this.presentationCapture === capture) this.presentationCapture = undefined;
            if (this.current(generation)) {
                await this.detachPresentationSenders(generation, true);
                this.send({type: 'group.call.presenter.stop', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, generation);
                this.setState({...this.state, presentation: undefined, sharing: false, screenShareAudioActive: false, shareTransitioning: false, statusLabel: capture?.videoEnded ? 'The selected screen ended before sharing started.' : 'Presentation was not started.'});
            }
        }
    }
    public stopPresentation(): Promise<void> {
        const capture = this.presentationCapture;
        return capture?.active ? this.enqueuePresentationOperation(() => this.stopPresentationCapture(capture)) : Promise.resolve();
    }
    public setScreenShareAudioEnabled(enabled: boolean): void {
        if (this.state.sharing || this.state.shareTransitioning) return;
        this.screenShareAudioEnabled = enabled;
        this.setState({...this.state, screenShareAudioEnabled: enabled});
    }
    public close(): void { this.terminal('Group call ended.', false); this.subscription.unsubscribe(); }
    public ngOnDestroy(): void { this.close(); }

    private handleEvent(event: MessageSocketEvent): void {
        if (event.type === 'call.rejected') {
            const discovery = this.pendingDiscovery;
            if (discovery && event.request_id === discovery.requestID && this.current(discovery.generation)) {
                this.pendingDiscovery = undefined;
                window.clearTimeout(this.discoveryTimeout);
                this.discoveryTimeout = undefined;
                this.fail(`Group call discovery failed: ${event.payload.error}. Try again.`);
                return;
            }
            const pending = this.pendingStartOrJoin;
            if (pending && event.request_id === pending.requestID && this.current(pending.generation)) {
                this.pendingStartOrJoin = undefined;
                const label = `Group call unavailable: ${event.payload.error}`;
                if (this.isDefinitiveRoomRejection(event.payload.error)) {
                    this.rejoinableRoom = undefined;
                    this.rejoinableStateRevision = -1;
                }
                this.fail(label);
                return;
            }
            const reconciliation = this.pendingControlReconciliation;
            if (reconciliation && event.request_id === reconciliation.syncRequestID) {
                window.clearTimeout(this.controlSyncTimeout);
                this.controlSyncTimeout = undefined;
                this.setControlReconciliationError(reconciliation);
                return;
            }
            const control = this.pendingControl;
            if (control && event.request_id === control.requestID) {
                this.pendingControl = undefined;
                if (this.generation === control.localGeneration && this.state.phase === (control.type === 'group.call.leave' ? 'left' : 'ended')) {
                    this.reconcileRejectedControl(control);
                }
            }
            return;
        }
        if (event.type === 'group.call.signal') {
            void this.signal(event);
            return;
        }
        if (event.type === 'group.call.discovered') {
            const pending = this.pendingDiscovery;
            if (!pending || event.request_id !== pending.requestID || event.payload.conversation_id !== pending.conversationID || !this.current(pending.generation)) return;
            this.pendingDiscovery = undefined;
            window.clearTimeout(this.discoveryTimeout);
            this.discoveryTimeout = undefined;
            this.setState(idleState);
            if (event.payload.room && event.payload.room.status !== 'ended') void this.join(event.payload.room, pending.selfID);
            else void this.start(pending.conversationID, pending.selfID);
            return;
        }
        if (event.type === 'group.call.synced') {
            this.handleSynced(event);
            return;
        }
        if (!this.isRoomEvent(event)) return;
        if (event.type === 'group.call.ended' && !isGroupRoomEventPayload(event.payload)) {
            if (!this.handleTerminalRoom(event.payload.room_id, event.payload.generation, event.payload.state_revision)) this.handleRejectedControlTerminal(event.payload.room_id, event.payload.generation, event.payload.state_revision);
            return;
        }
        if (!isGroupRoomEventPayload(event.payload)) return;
        const room = event.payload;
        if (room.status === 'ended' || event.type === 'group.call.ended') {
            if (!this.handleTerminalRoom(room.room_id, room.generation, room.state_revision)) this.handleRejectedControlTerminal(room.room_id, room.generation, room.state_revision);
            return;
        }
        if (this.state.phase === 'left' && this.rejoinableRoom?.room_id === room.room_id && this.rejoinableRoom.generation === room.generation) {
            if (room.state_revision <= this.rejoinableStateRevision) return;
            this.rejoinableStateRevision = room.state_revision;
            this.lastAppliedStateRevision = room.state_revision;
            this.rejoinableRoom = room;
            if (this.pendingControlReconciliation?.room.room_id === room.room_id && room.state_revision > this.pendingControlReconciliation.baselineRevision) {
                this.pendingControlReconciliation = {...this.pendingControlReconciliation, hasAdvancedRevision: true};
                this.controlStateUncertain = false;
            }
            return;
        }
        if (!this.acceptsRoomEvent(event, room)) return;
        if (event.type === 'group.call.started' || event.type === 'group.call.participant.joined' && this.state.phase === 'joining' && room.participants.some(participant => participant.user_id === this.selfID)) {
            this.pendingStartOrJoin = undefined;
            if (room.participants.some(participant => participant.user_id === this.selfID)) {
                this.rejoinableRoom = undefined;
                this.rejoinableStateRevision = -1;
            }
        }
        this.lastAppliedStateRevision = room.state_revision;
        if (event.type === 'group.call.started' && (this.state.phase === 'idle' || this.state.phase === 'left' || this.state.phase === 'ended' || this.state.phase === 'error')) {
            window.clearTimeout(this.dismissTimer);
            this.rejoinableRoom = undefined;
            this.rejoinableStateRevision = -1;
            this.setState({...idleState, phase: 'ringing', room, statusLabel: 'Group call is starting.'});
            return;
        }
        const previousPresenter = this.state.room?.presenter;
        if (event.type === 'group.call.participant.left' && previousPresenter && !room.participants.some(participant => participant.user_id === previousPresenter.user_id && participant.device_id === previousPresenter.device_id)) {
            this.clearRemotePresentation();
        }
        if (event.type === 'group.call.presenter.start') {
            const previousPresenter = this.state.room?.presenter;
            if (previousPresenter && !sameParticipant(previousPresenter, room.presenter)) this.clearRemotePresentation();
            if (this.state.presentation && (room.presenter?.user_id !== this.selfID || room.presenter?.device_id !== this.selfDeviceID())) this.clearPresentation(false);
        }
        if (event.type === 'group.call.presenter.stop') this.setState({...this.state, remotePresentation: undefined, peers: this.state.peers.map(peer => ({...peer, presentation: undefined}))});
        this.applyRoom(room, event.type === 'group.call.started' || event.type === 'group.call.participant.joined');
        if (event.type === 'group.call.presenter.start') this.restoreRemotePresentation(room);
    }

    private handleSynced(event: GroupCallSyncedSocketEvent): void {
        const controlReconciliation = this.pendingControlReconciliation;
        if (controlReconciliation?.syncRequestID === event.request_id) {
            this.pendingControlReconciliation = undefined;
            window.clearTimeout(this.controlSyncTimeout);
            this.controlSyncTimeout = undefined;
            const snapshot = event.payload;
            if (snapshot.room_id !== controlReconciliation.room.room_id || snapshot.generation !== controlReconciliation.room.generation ||
                this.generation !== controlReconciliation.localGeneration) return;
            if (snapshot.status === 'ended') {
                this.retireRoom(snapshot.room_id);
                this.controlStateUncertain = false;
                this.setState({...idleState, phase: 'ended', conversationID: controlReconciliation.room.conversation_id, statusLabel: 'The group call has ended.', errorLabel: controlRejectionLabel(controlReconciliation.type)});
                return;
            }
            if (snapshot.conversation_id !== controlReconciliation.room.conversation_id || snapshot.state_revision < controlReconciliation.baselineRevision) {
                this.setControlReconciliationError(controlReconciliation);
                return;
            }
            if (!snapshot.participants.some(participant => participant.user_id === controlReconciliation.userID && participant.device_id === controlReconciliation.deviceID)) {
                this.retireRoom(snapshot.room_id);
                this.controlStateUncertain = false;
                this.setState({...idleState, phase: 'ended', conversationID: controlReconciliation.room.conversation_id, statusLabel: 'You are no longer in the group call.', errorLabel: controlRejectionLabel(controlReconciliation.type)});
                return;
            }
            const room: GroupCallRoomPayload = {...snapshot, ice_servers: controlReconciliation.room.ice_servers};
            this.rejoinableRoom = room;
            this.rejoinableStateRevision = snapshot.state_revision;
            this.lastAppliedStateRevision = snapshot.state_revision;
            this.controlStateUncertain = false;
            this.setState({...idleState, phase: 'left', conversationID: controlReconciliation.room.conversation_id, statusLabel: `${controlRejectionLabel(controlReconciliation.type)} Rejoin to restore audio.`, errorLabel: controlRejectionLabel(controlReconciliation.type)});
            return;
        }
        const pending = this.pendingSync;
        const currentRoom = this.state.room;
        const snapshot = event.payload;
        if (!pending || pending.requestID !== event.request_id || pending.generation !== this.generation || !currentRoom ||
            snapshot.room_id !== currentRoom.room_id || snapshot.generation !== currentRoom.generation ||
            pending.roomID !== snapshot.room_id || pending.roomGeneration !== snapshot.generation) return;
        this.pendingSync = undefined;
        window.clearTimeout(this.syncRequestTimeout);
        this.syncRequestTimeout = undefined;
        if (snapshot.status === 'ended') {
            this.retireRoom(snapshot.room_id);
            this.terminal('Group call ended.');
            return;
        }
        if (snapshot.conversation_id !== currentRoom.conversation_id || snapshot.state_revision < this.lastAppliedStateRevision) return;
        const previousPresenter = currentRoom.presenter;
        if (!sameParticipant(previousPresenter, snapshot.presenter)) {
            this.clearRemotePresentation();
            if (this.state.presentation && (snapshot.presenter?.user_id !== this.selfID || snapshot.presenter?.device_id !== this.selfDeviceID())) this.clearPresentation(false);
        }
        this.lastAppliedStateRevision = snapshot.state_revision;
        // Active sync responses are state snapshots, not call-join responses. Keep
        // the existing TURN configuration and media ownership; never depend on
        // credentials being reissued to reconcile peers and presenter state.
        const room = {...snapshot, ice_servers: currentRoom.ice_servers};
        this.applyRoom(room, true);
        this.restoreRemotePresentation(room);
    }

    private isRoomEvent(event: MessageSocketEvent): event is GroupCallRoomSocketEvent {
        return event.type === 'group.call.started' || event.type === 'group.call.participant.joined' || event.type === 'group.call.participant.left' || event.type === 'group.call.presenter.start' || event.type === 'group.call.presenter.stop' || event.type === 'group.call.ended';
    }
    /**
     * Room generations belong to the server snapshot, while `generation` fences
     * local media callbacks.  Keep both boundaries: a local starter may adopt only
     * its own first room snapshot, and an established room never regresses or
     * switches IDs because of a delayed socket frame.
     */
    private acceptsRoomEvent(event: GroupCallRoomSocketEvent, room: GroupCallRoomEventPayload): boolean {
        const knownRoom = this.state.room;
        if (knownRoom) return knownRoom.room_id === room.room_id && room.generation === knownRoom.generation && room.state_revision > this.lastAppliedStateRevision;
        if (this.state.phase === 'idle' || this.state.phase === 'left' || this.state.phase === 'ended' || this.state.phase === 'error')
            return event.type === 'group.call.started' && !this.retiredRoomIDs.has(room.room_id) && room.state_revision > this.lastAppliedStateRevision;
        return event.type === 'group.call.started' && room.state_revision > this.lastAppliedStateRevision &&
            (this.state.phase === 'requesting' || this.state.phase === 'ringing') &&
            this.conversationID === room.conversation_id &&
            !this.retiredRoomIDs.has(room.room_id);
    }
    private applyRoom(room: GroupCallRoomPayload, offerNewPeers: boolean): void {
        const generation = this.generation;
        const local = this.state.localStream;
        const peers = room.participants.filter(participant => participant.user_id !== this.selfID).map(participant => this.peer(participant));
        const expected = new Set(peers.map(peer => this.key(peer.userID, peer.deviceID)));
        for (const [key, connection] of this.connections) {
            if (!expected.has(key)) {
                connection.connection.close();
                this.connections.delete(key);
                this.clearRemotePresentationForPeer(key);
                this.mediaSenders.delete(key);
                this.presentationSenders.delete(key);
                this.presentationAudioSenders.delete(key);
            }
        }
        this.setState({...this.state, room, peers, phase: local ? 'active' : 'ringing', statusLabel: local ? `${room.participants.length} participants in the group call.` : 'Group call is ready to join.'});
        if (local && room.status === 'active') this.startSyncLoop();
        if (!local || !room.ice_servers) return;
        for (const participant of room.participants) {
            if (participant.user_id === this.selfID) continue;
            const key = this.key(participant.user_id, participant.device_id);
            const isNewConnection = !this.connections.has(key);
            const connection = this.connectionFor(participant, room.ice_servers, generation);
            if (connection && isNewConnection && offerNewPeers && this.isOfferer(participant, room)) void this.offer(participant, connection, generation);
        }
    }
    /** The lexicographically smaller user/device identity owns the initial offer. */
    private isOfferer(participant: GroupCallParticipant, room: GroupCallRoomPayload): boolean {
        const self = room.participants.find(item => item.user_id === this.selfID && item.user_id !== participant.user_id);
        if (!self) return false;
        return comparePeerIdentity(self.user_id, self.device_id, participant.user_id, participant.device_id) < 0;
    }
    private peer(participant: GroupCallParticipant): GroupCallPeer {
        const existing = this.state.peers.find(peer => peer.userID === participant.user_id && peer.deviceID === participant.device_id);
        return {userID: participant.user_id, deviceID: participant.device_id, stream: existing?.stream, presentation: existing?.presentation};
    }
    private connectionFor(participant: GroupCallParticipant, iceServers: ICEServer[], generation: number): PeerConnectionState | undefined {
        const key = this.key(participant.user_id, participant.device_id);
        const existing = this.connections.get(key);
        if (existing) return existing;
        const stream = this.state.localStream;
        const room = this.state.room;
        if (!stream || !room || !this.current(generation)) return undefined;
        try {
            const connection = new RTCPeerConnection({iceServers});
            const state: PeerConnectionState = {connection, generation, remoteDescriptionReady: false, candidates: []};
            stream.getTracks().forEach(track => this.mediaSenders.set(key, connection.addTrack(track, stream)));
            // A participant can arrive after presentation began. Attach the current
            // owned track before the deterministic initial offer is created so its
            // SDP includes the presentation; keep the sender keyed per peer so stop,
            // restart, and teardown retain the existing ownership rules.
            const presentation = this.state.presentation;
            const presentationTrack = presentation?.getVideoTracks()[0];
            if (presentation && presentationTrack) {
                this.presentationSenders.set(key, connection.addTrack(presentationTrack, presentation));
                const audioTrack = presentation.getAudioTracks()[0];
                if (audioTrack) this.presentationAudioSenders.set(key, connection.addTrack(audioTrack, presentation));
            } else if (room.presenter && (room.presenter.user_id !== this.selfID || room.presenter.device_id !== this.selfDeviceID())) {
                // The deterministic offerer may be the late joiner, which cannot
                // add the presenter's sending track locally. Reserve a receive-only
                // video m-line on this new peer so the presenter's answer can
                // negotiate its existing sender even if presenter metadata is stale.
                connection.addTransceiver('video', {direction: 'recvonly'});
            }
            connection.onicecandidate = event => {
                if (event.candidate && this.current(generation) && this.connections.get(key) === state) this.sendSignal(participant, {type: 'candidate', candidate: event.candidate.toJSON()}, generation);
            };
            connection.ontrack = event => {
                if (!this.current(generation) || this.connections.get(key) !== state) return;
                const remote = event.streams[0] || new MediaStream([event.track]);
                if (event.track.kind === 'video') {
                    const currentRoom = this.state.room;
                    const receiver: RemotePresentationReceiver = {connection: state, generation, roomID: currentRoom?.room_id || '', roomGeneration: currentRoom?.generation || 0, stream: remote, track: event.track};
                    if (receiver.roomID) this.remotePresentationReceivers.set(key, receiver);
                    const updatePresentation = (): void => {
                        if (!this.isCurrentRemotePresentation(key, receiver) || event.track.muted || event.track.readyState !== 'live') return;
                        const room = this.state.room;
                        if (!room || !sameParticipant(room.presenter, {user_id: participant.user_id, device_id: participant.device_id})) return;
                        this.setState({...this.state, remotePresentation: remote, peers: this.state.peers.map(peer => peer.userID === participant.user_id && peer.deviceID === participant.device_id ? {...peer, presentation: remote} : peer)});
                    };
                    event.track.addEventListener('unmute', updatePresentation);
                    event.track.addEventListener('mute', () => {
                        if (this.isCurrentRemotePresentation(key, receiver) && this.state.remotePresentation === remote) this.clearRemotePresentation();
                    });
                    updatePresentation();
                    event.track.addEventListener('ended', () => {
                        if (this.remotePresentationReceivers.get(key) !== receiver) return;
                        this.remotePresentationReceivers.delete(key);
                        if (this.state.remotePresentation === remote) this.clearRemotePresentation();
                    }, {once: true});
                } else {
                    this.setState({...this.state, peers: this.state.peers.map(peer => peer.userID === participant.user_id && peer.deviceID === participant.device_id ? {...peer, stream: remote} : peer)});
                }
            };
            connection.onconnectionstatechange = () => {
                if (this.current(generation) && this.connections.get(key) === state && connection.connectionState === 'failed') this.removePeer(participant);
            };
            this.connections.set(key, state);
            void this.refreshDevices(generation);
            const pending = this.pendingSignals.get(key);
            if (pending) {
                this.pendingSignals.delete(key);
                for (const signal of pending) void this.applySignal(participant, state, signal, generation);
            }
            return state;
        } catch {
            this.fail('Group audio calls are not supported by this browser.');
            return undefined;
        }
    }
    private async signal(event: GroupCallSignalSocketEvent): Promise<void> {
        const room = this.state.room;
        if (!room || room.room_id !== event.payload.room_id || room.generation !== event.payload.generation || event.payload.from_user_id === this.selfID) return;
        const participant = {user_id: event.payload.from_user_id, device_id: event.payload.from_device_id};
        const key = this.key(participant.user_id, participant.device_id);
        const connection = room.ice_servers ? this.connectionFor(participant, room.ice_servers, this.generation) : undefined;
        if (!connection) {
            const pending = this.pendingSignals.get(key) || [];
            if (pending.length < 32) pending.push(event.payload.signal);
            this.pendingSignals.set(key, pending);
            return;
        }
        await this.applySignal(participant, connection, event.payload.signal, this.generation);
    }
    private async applySignal(participant: GroupCallParticipant, state: PeerConnectionState, signal: CallSignal, generation: number): Promise<void> {
        if (!this.current(generation) || state.generation !== generation) return;
        try {
            if (signal.type === 'candidate') {
                if (!state.remoteDescriptionReady) { state.candidates.push(signal.candidate as RTCIceCandidateInit); return; }
                await state.connection.addIceCandidate(signal.candidate as RTCIceCandidateInit);
                return;
            }
            if (signal.type === 'offer') {
                if (state.connection.signalingState !== 'stable') await state.connection.setLocalDescription({type: 'rollback'});
                await state.connection.setRemoteDescription({type: 'offer', sdp: signal.sdp});
                state.remoteDescriptionReady = true;
                await this.flushCandidates(state, generation);
                const answer = await state.connection.createAnswer();
                await state.connection.setLocalDescription(answer);
                if (answer.sdp) this.sendSignal(participant, {type: 'answer', sdp: answer.sdp}, generation);
            } else if (signal.type === 'answer' && state.connection.signalingState === 'have-local-offer') {
                await state.connection.setRemoteDescription({type: 'answer', sdp: signal.sdp});
                state.remoteDescriptionReady = true;
                await this.flushCandidates(state, generation);
            }
        } catch { if (this.current(generation)) this.removePeer(participant); }
    }
    private async flushCandidates(state: PeerConnectionState, generation: number): Promise<void> {
        for (const candidate of state.candidates.splice(0)) {
            if (!this.current(generation)) return;
            await state.connection.addIceCandidate(candidate);
        }
    }
    private async offer(participant: GroupCallParticipant, state: PeerConnectionState, generation: number): Promise<void> {
        if (!this.current(generation) || state.connection.signalingState !== 'stable') return;
        try {
            const offer = await state.connection.createOffer();
            if (!this.current(generation)) return;
            await state.connection.setLocalDescription(offer);
            if (offer.sdp) this.sendSignal(participant, {type: 'offer', sdp: offer.sdp}, generation);
        } catch { if (this.current(generation)) this.removePeer(participant); }
    }
    private async offerParticipant(key: string, state: PeerConnectionState, generation: number): Promise<void> {
        const peer = this.state.peers.find(item => this.key(item.userID, item.deviceID) === key);
        if (peer) await this.offer({user_id: peer.userID, device_id: peer.deviceID}, state, generation);
    }
    private sendSignal(target: GroupCallParticipant, signal: CallSignal, generation: number): void {
        const room = this.state.room;
        if (!room || !isPositiveGeneration(room.generation) || !this.current(generation)) return;
        this.send({type: 'group.call.signal', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation, target_user_id: target.user_id, target_device_id: target.device_id, signal}}, generation);
    }
    private removePeer(participant: GroupCallParticipant): void {
        const key = this.key(participant.user_id, participant.device_id);
        this.connections.get(key)?.connection.close();
        this.connections.delete(key);
        this.clearRemotePresentationForPeer(key);
        this.mediaSenders.delete(key); this.presentationSenders.delete(key); this.presentationAudioSenders.delete(key);
        this.setState({...this.state, peers: this.state.peers.filter(peer => this.key(peer.userID, peer.deviceID) !== key)});
    }
    private async microphone(generation: number): Promise<MediaStream | undefined> {
        if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function') { this.fail('Microphone access is unavailable.'); return undefined; }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: true});
            if (!this.current(generation)) { this.stop(stream); return undefined; }
            return stream;
        } catch { this.fail('Microphone permission was denied. Allow microphone access for this site and try again.'); return undefined; }
    }
    private send(event: Parameters<DataProviderService['send']>[0], generation: number): boolean {
        if (!this.current(generation) || this.dataProvider.send(event)) return this.current(generation);
        this.fail('The secure connection is unavailable.');
        return false;
    }
    private isDefinitiveRoomRejection(error: string): boolean {
        return error === 'call not found' || error === 'call not allowed' || error === 'call is not a group call';
    }
    private handleTerminalRoom(roomID: string, roomGeneration: number, revision: number): boolean {
        const room = this.state.room || this.rejoinableRoom || this.pendingControl?.room || this.pendingControlReconciliation?.room;
        if (!room || room.room_id !== roomID || room.generation !== roomGeneration) return false;
        const knownRevision = this.state.room?.room_id === roomID ? this.lastAppliedStateRevision
            : this.rejoinableRoom?.room_id === roomID ? this.rejoinableStateRevision
                : this.pendingControl?.room.room_id === roomID ? this.pendingControl.baselineRevision
                    : this.pendingControlReconciliation?.baselineRevision ?? -1;
        if (revision <= knownRevision) return false;
        this.lastAppliedStateRevision = revision;
        this.retireRoom(roomID);
        this.terminal('Group call ended.', true, false, roomID);
        return true;
    }
    private handleRejectedControlTerminal(roomID: string, roomGeneration: number, revision: number): void {
        const control = this.pendingControlReconciliation;
        if (!control || control.room.room_id !== roomID || control.room.generation !== roomGeneration || this.generation !== control.localGeneration) return;
        if (!control.hasAdvancedRevision || revision <= control.baselineRevision) return;
        this.pendingControlReconciliation = undefined;
        window.clearTimeout(this.controlSyncTimeout);
        this.controlSyncTimeout = undefined;
        this.retireRoom(roomID);
        this.setState({...idleState, phase: 'ended', conversationID: control.room.conversation_id, statusLabel: 'The group call has ended.', errorLabel: controlRejectionLabel(control.type)});
    }
    private reconcileRejectedControl(control: PendingGroupCallControl): void {
        if (this.pendingControlReconciliation || this.generation !== control.localGeneration) return;
        const syncRequestID = createRandomID();
        const reconciliation: PendingControlReconciliation = {...control, syncRequestID, hasAdvancedRevision: false};
        this.pendingControlReconciliation = reconciliation;
        if (!this.dataProvider.send({type: 'group.call.sync', request_id: syncRequestID, payload: {
            conversation_id: control.room.conversation_id, room_id: control.room.room_id, generation: control.room.generation,
        }})) {
            this.setControlReconciliationError(control);
            return;
        }
        this.controlSyncTimeout = window.setTimeout(() => {
            if (this.pendingControlReconciliation?.syncRequestID !== syncRequestID) return;
            this.pendingControlReconciliation = undefined;
            this.controlSyncTimeout = undefined;
            this.setControlReconciliationError(control);
        }, 8_000);
    }
    private setControlReconciliationError(control: PendingGroupCallControl): void {
        const label = controlRejectionLabel(control.type);
        if (control.localGeneration !== this.generation) return;
        this.controlStateUncertain = true;
        this.setState({...this.state, errorLabel: `${label} The current room state could not be verified.`, statusLabel: `${label} Room status could not be verified.`});
    }
    private terminal(label: string, dismiss = true, retireCurrentRoom = true, roomToRetire?: string): void {
        const terminalConversationID = this.state.room?.conversation_id ?? this.conversationID ?? this.rejoinableRoom?.conversation_id;
        this.pendingDiscovery = undefined;
        window.clearTimeout(this.discoveryTimeout);
        this.discoveryTimeout = undefined;
        this.pendingStartOrJoin = undefined;
        this.pendingControl = undefined;
        this.pendingControlReconciliation = undefined;
        this.controlStateUncertain = false;
        window.clearTimeout(this.controlSyncTimeout);
        this.controlSyncTimeout = undefined;
        this.rejoinableRoom = undefined;
        this.rejoinableStateRevision = -1;
        this.stopSyncLoop();
        if (retireCurrentRoom) this.retireRoom(this.state.room?.room_id);
        else if (roomToRetire) this.retireRoom(roomToRetire);
        // Server room revisions restart at one. The retired room ID, not the
        // previous revision, fences delayed events after a call ends.
        this.lastAppliedStateRevision = -1;
        this.generation += 1;
        if (this.presentationCapture) {
            this.presentationCapture.stopping = true;
            this.presentationCapture.active = false;
            this.presentationCapture = undefined;
        }
        for (const state of this.connections.values()) state.connection.close();
        this.connections.clear(); this.remotePresentationReceivers.clear(); this.pendingSignals.clear(); this.mediaSenders.clear(); this.presentationSenders.clear(); this.presentationAudioSenders.clear(); this.stop(this.state.localStream); this.stop(this.state.presentation);
        if (this.deviceListener) navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceListener);
        this.deviceListener = undefined;
        for (const audio of this.remoteAudios) { audio.pause(); audio.srcObject = null; }
        this.remoteAudios.clear();
        this.playbackRequestedAudios.clear();
        this.conversationID = undefined;
        this.selfID = undefined;
        this.setState({...idleState, phase: 'ended', conversationID: terminalConversationID, statusLabel: label});
        if (dismiss) this.dismissTerminalNoticeSoon();
    }
    private dismissTerminalNoticeSoon(): void {
        window.clearTimeout(this.dismissTimer);
        this.dismissTimer = window.setTimeout(() => {
            this.dismissTimer = undefined;
            if (this.state.phase === 'left' || this.state.phase === 'ended') this.setState(idleState);
        }, 5_000);
    }
    private handleDisconnect(): void {
        const room = this.state.room && this.state.room.participants.some(participant => participant.user_id !== this.selfID)
            ? this.state.room
            : this.rejoinableRoom;
        if (!room) {
            this.fail('Realtime connection lost. Rejoin the group call after reconnecting.');
            return;
        }
        const revision = this.state.room?.room_id === room.room_id ? this.lastAppliedStateRevision : this.rejoinableStateRevision;
        this.terminal('Realtime connection lost. Rejoin the group call after reconnecting.', false);
        this.rejoinableRoom = room;
        this.rejoinableStateRevision = revision;
        this.setState({...idleState, phase: 'left', conversationID: room.conversation_id, statusLabel: 'Realtime connection lost. Rejoin the group call after reconnecting.'});
    }
    private fail(label: string): void {
        const retryRoom = this.state.room && this.rejoinableRoom?.room_id === this.state.room.room_id && this.rejoinableRoom.generation === this.state.room.generation
            ? this.rejoinableRoom
            : undefined;
        const retryRevision = Math.max(this.rejoinableStateRevision, this.lastAppliedStateRevision);
        const terminalRevision = this.lastAppliedStateRevision;
        this.terminal(label, false);
        if (retryRoom) {
            this.rejoinableRoom = retryRoom;
            this.rejoinableStateRevision = Math.max(retryRevision, terminalRevision);
            this.setState({...idleState, phase: 'left', conversationID: retryRoom.conversation_id, statusLabel: label, errorLabel: label});
            return;
        }
        this.setState({...idleState, phase: 'error', conversationID: this.state.conversationID, statusLabel: label, errorLabel: label});
    }
    private beginGeneration(selfID: string, conversationID: string): number { window.clearTimeout(this.dismissTimer); this.dismissTimer = undefined; this.screenShareAudioEnabled = false; this.stopSyncLoop(); this.remotePresentationReceivers.clear(); this.pendingControl = undefined; this.pendingControlReconciliation = undefined; window.clearTimeout(this.controlSyncTimeout); this.controlSyncTimeout = undefined; this.lastAppliedStateRevision = -1; this.generation += 1; this.selfID = selfID; this.conversationID = conversationID; return this.generation; }
    private current(generation: number): boolean { return generation === this.generation; }
    private canStart(): boolean { return ['idle', 'left', 'ended', 'error', 'ringing'].includes(this.state.phase); }
    private key(userID: string, deviceID: string): string { return `${userID}:${deviceID}`; }
    private retireRoom(roomID: string | undefined): void {
        if (!roomID) return;
        this.retiredRoomIDs.add(roomID);
        while (this.retiredRoomIDs.size > 32) {
            const oldest = this.retiredRoomIDs.values().next();
            if (oldest.done || oldest.value === undefined) break;
            this.retiredRoomIDs.delete(oldest.value);
        }
    }
    private stop(stream?: MediaStream): void { stream?.getTracks().forEach(track => track.stop()); }
    private async tryPlayRemoteAudio(audio: HTMLAudioElement, generation: number): Promise<void> {
        if (!this.current(generation)) return;
        try {
            audio.autoplay = true;
            audio.muted = false;
            audio.volume = 1;
            await audio.play();
            if (this.current(generation) && this.state.audioPlaybackBlocked) this.setState({...this.state, audioPlaybackBlocked: false, statusLabel: 'Group audio connected.'});
        } catch (error: unknown) {
            if (!this.current(generation) || !(error instanceof DOMException) || error.name !== 'NotAllowedError') return;
            this.setState({...this.state, audioPlaybackBlocked: true, statusLabel: 'Group audio connected. Enable sound to hear the call.'});
        }
    }
    private outputSink(audio: HTMLAudioElement): AudioOutputSink | undefined {
        return hasAudioOutputSink(audio) ? audio : undefined;
    }
    private async applyOutputDevice(audio: HTMLAudioElement, deviceID: string): Promise<void> {
        const sink = this.outputSink(audio);
        if (!sink) { this.setState({...this.state, statusLabel: 'Speaker selection is not supported by this browser.'}); return; }
        try { await sink.setSinkId(deviceID); } catch { this.setState({...this.state, statusLabel: 'The selected speaker is unavailable.'}); }
    }
    private async replaceTrack(key: string, sender: RTCRtpSender, track: MediaStreamTrack | null, generation = this.generation): Promise<void> {
        let timeout: number | undefined;
        try {
            await Promise.race([
                sender.replaceTrack(track),
                new Promise<never>((_resolve, reject) => {
                    timeout = window.setTimeout(() => reject(new Error('RTCRtpSender.replaceTrack timed out.')), 1_500);
                }),
            ]);
        } catch (error: unknown) {
            // A timed-out sender may still apply the replacement later. Close its
            // owning peer before releasing the queue so stale media cannot attach.
            if (this.current(generation)) {
                const participant = this.state.peers.find(peer => this.key(peer.userID, peer.deviceID) === key);
                if (participant) this.removePeer({user_id: participant.userID, device_id: participant.deviceID});
                this.setState({...this.state, errorLabel: 'A peer connection was closed because media could not be replaced.'});
            }
            throw error;
        } finally {
            if (timeout !== undefined) window.clearTimeout(timeout);
        }
    }
    private clearPresentation(transitioning: boolean): void {
        const generation = this.generation;
        void this.enqueuePresentationOperation(async () => {
            if (!this.current(generation)) return;
            const capture = this.presentationCapture;
            if (capture) { capture.stopping = true; capture.active = false; }
            this.presentationCapture = undefined;
            this.stop(this.state.presentation);
            this.setState({...this.state, presentation: undefined, sharing: false, screenShareAudioActive: false, shareTransitioning: true});
            await this.detachPresentationSenders(generation, true);
            if (this.current(generation)) this.setState({...this.state, presentation: undefined, sharing: false, screenShareAudioActive: false, shareTransitioning: transitioning});
        });
    }
    private assertPresentationVideoLive(capture: LocalPresentationCapture): void {
        if (capture.videoEnded || capture.videoTrack.readyState !== 'live' || !this.current(capture.generation) || this.presentationCapture !== capture || capture.stopping) {
            throw new Error('Presentation video ended during startup.');
        }
    }
    private enqueuePresentationOperation(operation: () => Promise<void>): Promise<void> {
        const queued = this.presentationOperationQueue.then(operation, operation);
        this.presentationOperationQueue = queued.catch(() => undefined);
        return queued;
    }
    private stopPresentationCapture(capture: LocalPresentationCapture): Promise<void> {
        if (capture.stopPromise) return capture.stopPromise;
        if (this.presentationCapture !== capture || !this.current(capture.generation) || capture.stopping) return Promise.resolve();
        capture.stopping = true;
        capture.active = false;
        const room = this.state.room;
        this.setState({...this.state, presentation: undefined, sharing: false, screenShareAudioActive: false, shareTransitioning: true, statusLabel: 'Stopping presentation...'});
        if (room && isPositiveGeneration(room.generation)) {
            this.send({type: 'group.call.presenter.stop', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, capture.generation);
        }
        this.stop(capture.stream);
        capture.stopPromise = (async () => {
            await this.detachPresentationSenders(capture.generation, true);
            if (this.current(capture.generation) && this.presentationCapture === capture) {
                this.presentationCapture = undefined;
                this.setState({...this.state, presentation: undefined, sharing: false, screenShareAudioActive: false, shareTransitioning: false, statusLabel: 'Presentation stopped.'});
            }
        })();
        return capture.stopPromise;
    }
    private stopPresentationAudio(capture: LocalPresentationCapture): Promise<void> {
        if (capture.audioStopping || capture.stopping || !capture.active || this.presentationCapture !== capture || !capture.audioTrack) return Promise.resolve();
        capture.audioStopping = true;
        capture.audioEnded = true;
        this.setState({...this.state, shareTransitioning: true, statusLabel: 'Stopping system audio...'});
        capture.audioTrack.stop();
        capture.stream.removeTrack(capture.audioTrack);
        return (async () => {
            for (const [key, sender] of this.presentationAudioSenders) {
                await this.replaceTrack(key, sender, null, capture.generation).catch(() => undefined);
                const peer = this.connections.get(key);
                if (peer) await this.offerParticipant(key, peer, capture.generation);
            }
            if (this.presentationCapture === capture && this.current(capture.generation) && !capture.stopping) {
                capture.audioStopping = false;
                this.setState({...this.state, screenShareAudioActive: false, shareTransitioning: false, statusLabel: 'System audio stopped. Your presentation is still visible.'});
            }
        })();
    }
    private async detachPresentationSenders(generation: number, renegotiate: boolean): Promise<void> {
        const keys = new Set([...this.presentationSenders.keys(), ...this.presentationAudioSenders.keys()]);
        for (const key of keys) {
            if (!this.current(generation)) return;
            const videoSender = this.presentationSenders.get(key);
            const audioSender = this.presentationAudioSenders.get(key);
            await Promise.all([
                videoSender ? this.replaceTrack(key, videoSender, null, generation).catch(() => undefined) : Promise.resolve(),
                audioSender ? this.replaceTrack(key, audioSender, null, generation).catch(() => undefined) : Promise.resolve(),
            ]);
            const peer = this.connections.get(key);
            if (renegotiate && peer) await this.offerParticipant(key, peer, generation);
        }
    }
    private clearRemotePresentation(): void {
        this.setState({...this.state, remotePresentation: undefined, peers: this.state.peers.map(peer => ({...peer, presentation: undefined}))});
    }
    private clearRemotePresentationForPeer(key: string): void {
        const receiver = this.remotePresentationReceivers.get(key);
        this.remotePresentationReceivers.delete(key);
        if (receiver && this.state.remotePresentation === receiver.stream) this.clearRemotePresentation();
    }
    private isCurrentRemotePresentation(key: string, receiver: RemotePresentationReceiver): boolean {
        return this.current(receiver.generation) && this.remotePresentationReceivers.get(key) === receiver &&
            this.connections.get(key) === receiver.connection && receiver.connection.generation === receiver.generation &&
            this.state.room?.room_id === receiver.roomID && this.state.room.generation === receiver.roomGeneration;
    }
    private restoreRemotePresentation(room: GroupCallRoomPayload): void {
        const presenter = room.presenter;
        if (!presenter || presenter.user_id === this.selfID && presenter.device_id === this.selfDeviceID()) return;
        const key = this.key(presenter.user_id, presenter.device_id);
        const receiver = this.remotePresentationReceivers.get(key);
        if (!receiver || !this.isCurrentRemotePresentation(key, receiver) || receiver.track.muted || receiver.track.readyState !== 'live' || !receiver.stream.active) return;
        this.setState({...this.state, remotePresentation: receiver.stream, peers: this.state.peers.map(peer => peer.userID === presenter.user_id && peer.deviceID === presenter.device_id ? {...peer, presentation: receiver.stream} : peer)});
    }
    private selfDeviceID(): string | undefined { return this.state.room?.participants.find(item => item.user_id === this.selfID)?.device_id; }
    private screenConstraints(quality: GroupScreenQuality): MediaTrackConstraints {
        const dimensions: Record<GroupScreenQuality, [number, number]> = { '360p': [640, 360], '720p': [1280, 720], '1080p': [1920, 1080], '2k': [2560, 1440] };
        const [width, height] = dimensions[quality];
        return {width: {ideal: width}, height: {ideal: height}, frameRate: {max: 15}};
    }
    private async refreshDevices(generation: number): Promise<void> {
        if (!navigator.mediaDevices?.enumerateDevices || !this.current(generation)) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!this.current(generation)) return;
        this.setState({...this.state, inputDevices: devices.filter(device => device.kind === 'audioinput'), outputDevices: devices.filter(device => device.kind === 'audiooutput')});
        if (!this.deviceListener) { this.deviceListener = () => void this.refreshDevices(this.generation); navigator.mediaDevices.addEventListener?.('devicechange', this.deviceListener); }
    }
    private setState(state: GroupCallState): void { this.stateSubject.next(Object.freeze({...state, peers: [...state.peers]})); }

    private startSyncLoop(): void {
        if (this.syncTimer !== undefined || !this.dataProvider.ready || this.state.phase !== 'active' || !this.state.room || !this.state.localStream) return;
        const generation = this.generation;
        this.syncTimer = window.setInterval(() => {
            if (!this.current(generation) || this.state.phase !== 'active' || !this.dataProvider.ready) return;
            if (this.pendingSync) return;
            const room = this.state.room;
            if (!room || !isPositiveGeneration(room.generation)) return;
            const requestID = createRandomID();
            if (!this.current(generation) || !this.dataProvider.send({type: 'group.call.sync', request_id: requestID, payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}})) return;
            this.pendingSync = {requestID, generation, roomID: room.room_id, roomGeneration: room.generation};
            this.syncRequestTimeout = window.setTimeout(() => {
                if (this.pendingSync?.requestID === requestID) this.pendingSync = undefined;
                this.syncRequestTimeout = undefined;
            }, 8_000);
        }, 10_000);
    }

    private stopSyncLoop(): void {
        if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
        this.syncTimer = undefined;
        window.clearTimeout(this.syncRequestTimeout);
        this.syncRequestTimeout = undefined;
        this.pendingSync = undefined;
    }
}

function controlRejectionLabel(type: GroupCallControlType): string {
    return type === 'group.call.leave' ? 'Could not leave the group call.' : 'Could not end the group call.';
}

function hasAudioOutputSink(audio: object): audio is AudioOutputSink {
    return 'setSinkId' in audio && typeof Reflect.get(audio, 'setSinkId') === 'function';
}

function isPositiveGeneration(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function sameParticipant(left: GroupCallParticipant | undefined, right: GroupCallParticipant | undefined): boolean {
    return left?.user_id === right?.user_id && left?.device_id === right?.device_id;
}

function comparePeerIdentity(leftUserID: string, leftDeviceID: string, rightUserID: string, rightDeviceID: string): number {
    if (leftUserID !== rightUserID) return leftUserID < rightUserID ? -1 : 1;
    if (leftDeviceID === rightDeviceID) return 0;
    return leftDeviceID < rightDeviceID ? -1 : 1;
}
