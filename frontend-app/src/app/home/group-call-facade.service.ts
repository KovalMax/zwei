import {Injectable, OnDestroy} from '@angular/core';
import {BehaviorSubject, Subscription} from 'rxjs';
import {DataProviderService, GroupCallDiscoveredSocketEvent, GroupCallParticipant, GroupCallRoomEventPayload, GroupCallRoomPayload, GroupCallRoomSocketEvent, GroupCallSignal, GroupCallSignalSocketEvent, GroupCallSyncedSocketEvent, ICEServer, isGroupRoomEventPayload, MessageSocketEvent} from './data-provider.service';
import {createRandomID} from '../login/login';
import {iceCandidateIdentity, iceGenerations, IceCandidateIdentity, IceMediaGeneration, matchesIceGeneration, outgoingIceCandidate} from './group-ice-generation';

export type GroupCallPhase = 'idle' | 'requesting' | 'ringing' | 'joining' | 'active' | 'left' | 'ended' | 'error';
export type GroupScreenQuality = '360p' | '720p' | '1080p' | '2k';
export interface GroupCallPeer { readonly userID: string; readonly deviceID: string; readonly stream?: MediaStream; readonly presentation?: MediaStream; }
export interface GroupCallState {
    readonly phase: GroupCallPhase;
    /** Conversation owning a short-lived terminal notice, even after room teardown. */
    readonly conversationID?: string;
    readonly supportRef?: string;
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
    readonly invitationRinging?: boolean;
    readonly soloPrompt?: boolean;
}

const idleState: GroupCallState = Object.freeze({phase: 'idle', peers: [], muted: false, sharing: false, screenShareAudioEnabled: false, screenShareAudioActive: false, shareTransitioning: false, inputDevices: [], outputDevices: [], audioPlaybackBlocked: false, statusLabel: 'No active group call.'});
const cleanupUnverifiedError = 'Group call cleanup could not be verified. The current room state could not be verified. Start a group call to check again.';
const cleanupOwnedElsewhereError = 'This group call is still reserved on another connection. Leave it there, then start a group call to check again.';
const credentialsWarning = 'Call connection credentials could not be refreshed. Retrying automatically.';
const peerRestartWarning = 'A group call connection could not be refreshed. Retrying automatically.';
const iceFailure = 'A participant connection failed. Leave and rejoin the group call to reconnect.';
const iceUncertainWarning = 'A participant connection could not be verified. If audio is missing, leave and rejoin the group call.';
const iceQueueLimit = 64;
const iceQueueTimeout = 15_000;

interface PeerConnectionState {
    readonly connection: RTCPeerConnection;
    readonly generation: number;
    readonly participant: GroupCallParticipant;
    operationQueue: Promise<void>;
    queuedOperations: number;
    closed: boolean;
    readonly cancellations: Set<() => void>;
    restartPending: boolean;
    restartOffered: boolean;
    restartEpoch: number;
    restartUpdating: boolean;
    restartOffer?: {requestID: string; epoch: number};
    restartAttempt: number;
    restartRollback: boolean;
    microphoneRepairPending: boolean;
    outstandingNegotiation?: string;
    restartTimer?: number;
    currentIce: IceMediaGeneration[];
    pendingIce: IceMediaGeneration[];
    readonly retiredIce: IceMediaGeneration[];
    localIce: IceMediaGeneration[];
    readonly retiredLocalIce: IceMediaGeneration[];
    readonly unresolvedIce: {identity: IceCandidateIdentity; replacementApplied: boolean}[];
    unresolvedIceOverflow: boolean;
    readonly candidates: {candidate: RTCIceCandidateInit; identity: IceCandidateIdentity; timer: number}[];
    readonly signalOperations: Set<number>;
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
    readonly failureCleanup?: boolean;
    readonly originalFailureLabel?: string;
    readonly controlRetried?: boolean;
}
interface PendingControlReconciliation extends PendingGroupCallControl {
    readonly syncRequestID: string;
    readonly hasAdvancedRevision: boolean;
    readonly retryCleanup: boolean;
}

@Injectable()
export class GroupCallFacade implements OnDestroy {
    private readonly stateSubject = new BehaviorSubject<GroupCallState>(idleState);
    private readonly subscription: Subscription;
    private readonly connections = new Map<string, PeerConnectionState>();
    private readonly failedPeers = new Set<string>();
    private readonly uncertainPeers = new Set<string>();
    private readonly pendingSignals = new Map<string, {signal: GroupCallSignal; timer: number; deadline: number}[]>();
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
    private invitationTimer?: number;
    private invitationPeerJoined = false;
    private syncTimer?: number;
    private credentialsTimer?: number;
    private pendingCredentials?: {requestID: string; generation: number; roomID: string; roomGeneration: number; attempts: number};
    private scheduledCredentialsExpiry?: string;
    private credentialsFailed = false;
    private restartWarningActive = false;
    private syncRequestTimeout?: number;
    private pendingSync?: {requestID: string; generation: number; roomID: string; roomGeneration: number};
    private syncVerificationFailures = 0;
    private pendingStartOrJoin?: {requestID: string; generation: number};
    private acceptedStart?: {requestID: string; roomID: string; generation: number};
    private earlyStartedEvents: GroupCallRoomSocketEvent[] = [];
    private readonly preparations = new Map<string, {generation: number; conversationID: string; resolve: (attemptID?: string) => void; timer: number}>();
    private startAttempt?: {conversationID: string; attemptID: string};
    private readonly startCancellations = new Map<string, {conversationID: string; requestID: string; sends: number; deadline: number; timer?: number}>();
    private startJoinTimeout?: number;
    private pendingDiscovery?: {requestID: string; generation: number; conversationID: string; selfID: string; endedRooms: Set<string>; room?: {room_id: string; generation: number}};
    private observerTimer?: number;
    private observerPending?: {requestID: string; generation: number; conversationID: string; roomID: string; roomGeneration: number; revision: number};
    private observerFailures = 0;
    private observerUnknown = false;
    private deferredIntent?: {generation: number; conversationID: string; selfID: string; room?: {room_id: string; generation: number}};
    private discoveryTimeout?: number;
    private screenShareAudioEnabled = false;
    private pendingControl?: PendingGroupCallControl;
    private uncertainCleanup?: PendingGroupCallControl;
    private pendingControlReconciliation?: PendingControlReconciliation;
    private controlSyncTimeout?: number;
    private controlStateUncertain = false;
    private lastAppliedStateRevision = -1;
    private deviceListener?: () => void;
    private readonly remoteAudios = new Set<HTMLAudioElement>();
    private readonly playbackRequestedAudios = new Set<HTMLAudioElement>();
    private presentationOperationQueue: Promise<void> = Promise.resolve();
    private inputOperationQueue: Promise<void> = Promise.resolve();
    private readonly pendingMicrophones = new Set<MediaStream>();
    public readonly state$ = this.stateSubject.asObservable();

    public constructor(private readonly dataProvider: DataProviderService) {
        this.subscription = this.dataProvider.getObservable().subscribe(event => this.handleEvent(event));
        this.subscription.add(this.dataProvider.readyChanges.subscribe(ready => {
            if (!ready && this.pendingControlReconciliation) {
                window.clearTimeout(this.controlSyncTimeout);
                this.controlSyncTimeout = undefined;
                this.setControlReconciliationError(this.pendingControlReconciliation);
            } else if (!ready && this.observerRoom()) {
                this.stopObserverDiscovery();
                this.observerUnknown = true;
                this.setState({...this.state, statusLabel: 'Group call status is unknown. Checking when the connection returns.'});
            } else if (!ready && !this.controlStateUncertain && (this.isOngoing || this.state.phase === 'left' || this.state.phase === 'requesting')) this.handleDisconnect();
            else if (ready) {
                for (const attemptID of this.startCancellations.keys()) this.retryStartCancellation(attemptID);
                if (this.uncertainCleanup && !this.pendingControlReconciliation && (this.uncertainCleanup.failureCleanup || this.deferredIntent)) this.reconcileRejectedControl(this.uncertainCleanup, this.uncertainCleanup.failureCleanup && !this.uncertainCleanup.deviceID);
                this.startSyncLoop();
                if (this.observerRoom()) this.scheduleObserverDiscovery(0);
                if (this.credentialsFailed && !this.pendingCredentials && this.credentialsTimer === undefined && this.state.room && this.state.localStream) this.requestCredentials(this.state.room, this.generation, 1);
            }
        }));
    }
    public get state(): GroupCallState { return this.stateSubject.value; }
    public get isOngoing(): boolean { return ['ringing', 'joining', 'active'].includes(this.state.phase); }
    public stayInSoloCall(): void {
        if (this.state.soloPrompt) this.setState({...this.state, soloPrompt: false});
    }
    public canRejoin(conversationID: string): boolean { return (this.state.phase === 'left' || this.state.phase === 'idle') && !this.pendingControlReconciliation && !this.controlStateUncertain && this.rejoinableRoom?.conversation_id === conversationID; }

    public async start(conversationID: string, selfID: string): Promise<void> {
        if (!this.canStart()) return;
        const generation = this.beginGeneration(selfID, conversationID);
        this.rejoinableRoom = undefined;
        this.rejoinableStateRevision = -1;
        this.setState({...idleState, phase: 'requesting', statusLabel: 'Preparing group call...'});
        const attemptID = await this.prepareStart(conversationID, generation);
        if (!attemptID || !this.current(generation)) return;
        this.startAttempt = {conversationID, attemptID};
        this.setState({...this.state, statusLabel: 'Requesting microphone access...'});
        this.startJoinTimeout = window.setTimeout(() => {
            if (this.current(generation) && this.startAttempt?.attemptID === attemptID) this.fail('Microphone access timed out. Try again.');
        }, 8_000);
        const stream = await this.microphone(generation);
        if (!stream || !this.current(generation)) return;
        window.clearTimeout(this.startJoinTimeout);
        this.startJoinTimeout = undefined;
        this.setState({...this.state, phase: 'ringing', localStream: stream, statusLabel: 'Starting group call...'});
        const requestID = createRandomID();
        this.acceptedStart = undefined;
        this.earlyStartedEvents = [];
        this.pendingStartOrJoin = {requestID, generation};
        if (!this.send({type: 'group.call.start', request_id: requestID, payload: {conversation_id: conversationID, attempt_id: attemptID}}, generation)) {
            this.pendingStartOrJoin = undefined;
            this.stop(stream);
            return;
        }
        this.armStartJoinTimeout(requestID, generation, conversationID, selfID);
    }

    /** Discover first so only an authorized, current room can be joined. */
    public discoverAndStart(conversationID: string, selfID: string): void {
        this.discover(conversationID, selfID);
    }

    private discover(conversationID: string, selfID: string, room?: {room_id: string; generation: number}): void {
        if ((this.uncertainCleanup || this.pendingControl || this.pendingControlReconciliation) && this.dataProvider.ready) {
            this.deferredIntent = {generation: this.generation, conversationID, selfID, room};
        }
        // A call attempt is also the explicit retry for an uncertain cleanup.
        // Never continue into discovery until a correlated absence is confirmed.
        if (this.uncertainCleanup) {
            if (this.dataProvider.ready && !this.pendingControlReconciliation) {
                this.setState({...this.state, statusLabel: 'Checking the previous group call reservation…'});
                this.reconcileRejectedControl({...this.uncertainCleanup, controlRetried: false}, true);
            }
            return;
        }
        if (!this.canStart() || this.pendingDiscovery || !this.dataProvider.ready) return;
        const generation = this.beginGeneration(selfID, conversationID);
        this.setState({...idleState, phase: 'requesting', statusLabel: 'Checking for an active group call…'});
        const requestID = createRandomID();
        this.pendingDiscovery = {requestID, generation, conversationID, selfID, endedRooms: new Set(), room};
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
        this.armStartJoinTimeout(requestID, generation, room.conversation_id, selfID, room);
        this.startSyncLoop();
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
            this.setState({...idleState, phase: 'left', conversationID: room.conversation_id, supportRef: room.support_ref || this.state.supportRef, statusLabel: 'You left the group call.'});
        }
        this.dismissTerminalNoticeSoon();
    }
    public rejoin(selfID: string): void {
        const room = this.rejoinableRoom;
        if (room && (this.pendingControl || this.pendingControlReconciliation || this.uncertainCleanup)) {
            this.discover(room.conversation_id, selfID, {room_id: room.room_id, generation: room.generation});
            return;
        }
        if (room && (this.state.phase === 'left' || this.state.phase === 'idle')) void this.join(room, selfID);
    }
    public cancelDeferredIntentForConversation(conversationID: string): void {
        if (this.deferredIntent && this.deferredIntent.conversationID !== conversationID) this.deferredIntent = undefined;
        if (this.pendingDiscovery && this.pendingDiscovery.conversationID !== conversationID) this.terminal('Group call check cancelled.', false);
    }
    public end(): void {
        if (this.startCancellations.size || this.controlStateUncertain || this.pendingControlReconciliation?.failureCleanup) return;
        if (this.pendingStartOrJoin && this.selfID && this.conversationID) {
            this.cancelPendingAdmission('Group call cancelled. Your microphone has been stopped while the reservation is checked.');
            return;
        }
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
        if (this.controlStateUncertain || this.pendingControlReconciliation?.failureCleanup) return false;
        if (this.conversationID !== conversationID && this.state.room?.conversation_id !== conversationID && this.rejoinableRoom?.conversation_id !== conversationID) return false;
        if (this.pendingStartOrJoin && this.selfID && this.conversationID) {
            this.cancelPendingAdmission('Group call cancelled. Your microphone has been stopped while the reservation is checked.');
            return true;
        }
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
        for (const pending of this.pendingMicrophones) pending.getAudioTracks().forEach(track => track.enabled = !muted);
        this.setState({...this.state, muted, statusLabel: muted ? 'Microphone muted.' : 'Microphone on.'});
    }
    public selectInputDevice(deviceID: string): Promise<void> {
        const generation = this.generation;
        const queued = this.inputOperationQueue.then(() => this.selectInputDeviceNow(deviceID, generation));
        this.inputOperationQueue = queued.catch(() => undefined);
        return queued;
    }
    private async selectInputDeviceNow(deviceID: string, generation: number): Promise<void> {
        if (!this.state.localStream || !this.current(generation)) return;
        let replacement: MediaStream | undefined;
        try {
            replacement = await navigator.mediaDevices.getUserMedia({audio: {deviceId: {exact: deviceID}}});
            if (!this.current(generation)) { this.stop(replacement); return; }
            const track = replacement.getAudioTracks()[0];
            if (!track) { this.stop(replacement); return; }
            this.pendingMicrophones.add(replacement);
            // replaceTrack does not inherit the previous track's enabled state.
            // Apply the call's mute state before any peer can send this track.
            track.enabled = !this.state.muted;
            const previousTrack = this.state.localStream.getAudioTracks()[0];
            const replaced: Array<{key: string; sender: RTCRtpSender; peer: PeerConnectionState}> = [];
            try {
                for (const [key, sender] of this.mediaSenders) {
                    const peer = this.connections.get(key);
                    if (!peer) throw new Error('Microphone peer is unavailable.');
                    await this.enqueuePeerOperation(peer, async () => {
                        if (!this.current(generation) || this.connections.get(key) !== peer || this.mediaSenders.get(key) !== sender) throw new Error('Microphone peer changed.');
                        await this.replaceTrack(key, sender, track, generation);
                        if (!this.current(generation) || this.connections.get(key) !== peer || this.mediaSenders.get(key) !== sender) throw new Error('Microphone peer changed.');
                    }, true);
                    replaced.push({key, sender, peer});
                }
            } catch (error: unknown) {
                // Keep the previous stream alive until every peer has switched. Restore
                // senders already updated so a failed selection cannot leave them using
                // a track that is stopped below.
                if (this.current(generation) && previousTrack && previousTrack.readyState !== 'ended') {
                    for (const {key, sender, peer} of replaced.reverse()) {
                        await this.enqueuePeerOperation(peer, async () => {
                            if (this.current(generation) && this.connections.get(key) === peer && this.mediaSenders.get(key) === sender) await this.replaceTrack(key, sender, previousTrack, generation);
                        }).catch(() => undefined);
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
        } finally {
            if (replacement) this.pendingMicrophones.delete(replacement);
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
            await Promise.all([...this.connections].map(([key, state]) => this.enqueuePeerOperation(state, async () => {
                if (!this.current(generation) || this.connections.get(key) !== state) return;
                this.assertPresentationVideoLive(localCapture);
                const sender = this.presentationSenders.get(key) || state.connection.addTrack(videoTrack, localCapture.stream);
                this.presentationSenders.set(key, sender);
                await this.replaceTrack(key, sender, videoTrack, generation);
                this.assertPresentationVideoLive(localCapture);
                if (this.connections.get(key) !== state) return;
                if (audioTrack && !localCapture.audioEnded && audioTrack.readyState === 'live') {
                    const audioSender = this.presentationAudioSenders.get(key) || state.connection.addTrack(audioTrack, localCapture.stream);
                    this.presentationAudioSenders.set(key, audioSender);
                    await this.replaceTrack(key, audioSender, audioTrack, generation);
                    if (this.connections.get(key) !== state) return;
                    if (localCapture.audioEnded || audioTrack.readyState !== 'live') await this.replaceTrack(key, audioSender, null, generation);
                }
                await this.offerParticipant(key, state, generation);
                this.assertPresentationVideoLive(localCapture);
            }, true)));
            if (audioTrack && (capture.audioEnded || audioTrack.readyState !== 'live')) {
                capturedStream.removeTrack(audioTrack);
                await Promise.all([...this.presentationAudioSenders].map(([key, sender]) => {
                    const peer = this.connections.get(key);
                    return peer ? this.enqueuePeerOperation(peer, async () => {
                        if (!this.current(generation) || this.connections.get(key) !== peer) return;
                        await this.replaceTrack(key, sender, null, generation);
                        await this.offerParticipant(key, peer, generation);
                    }) : Promise.resolve();
                }));
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
    public close(): void {
        this.terminal('Group call ended.', false);
        for (const preparation of this.preparations.values()) { window.clearTimeout(preparation.timer); preparation.resolve(); }
        this.preparations.clear();
        for (const cancellation of this.startCancellations.values()) window.clearTimeout(cancellation.timer);
        this.subscription.unsubscribe();
    }
    public ngOnDestroy(): void { this.close(); }

    private handleEvent(event: MessageSocketEvent): void {
        if (event.type === 'group.call.start_accepted') {
            const pending = this.pendingStartOrJoin;
            if (!this.startAttempt || !pending || pending.requestID !== event.request_id || !this.current(pending.generation) || event.payload.conversation_id !== this.startAttempt.conversationID) return;
            this.acceptedStart = {requestID: event.request_id, roomID: event.payload.room_id, generation: event.payload.generation};
            const early = this.earlyStartedEvents.find(item => item.payload.room_id === event.payload.room_id && item.payload.generation === event.payload.generation);
            this.earlyStartedEvents = [];
            if (early) this.handleEvent(early);
            return;
        }
        if (event.type === 'group.call.start_prepared') {
            const preparation = this.preparations.get(event.request_id);
            if (!preparation || preparation.conversationID !== event.payload.conversation_id) return;
            this.preparations.delete(event.request_id);
            window.clearTimeout(preparation.timer);
            if (!this.current(preparation.generation) || Date.parse(event.payload.expires_at) <= Date.now()) {
                this.cancelStartAttempt(event.payload.conversation_id, event.payload.attempt_id);
                preparation.resolve();
                if (this.current(preparation.generation)) this.fail('Group call preparation expired. Try again.');
            } else {
                this.startAttempt = {conversationID: event.payload.conversation_id, attemptID: event.payload.attempt_id};
                preparation.resolve(event.payload.attempt_id);
            }
            return;
        }
        if (event.type === 'group.call.start_cancelled') {
            const cancellation = this.startCancellations.get(event.payload.attempt_id);
            if (!cancellation || cancellation.requestID !== event.request_id || cancellation.conversationID !== event.payload.conversation_id) return;
            if (event.payload.outcome === 'unknown') {
                this.showStartCleanupUnverified();
                return;
            }
            window.clearTimeout(cancellation.timer);
            this.startCancellations.delete(event.payload.attempt_id);
            if (!this.startCancellations.size && this.state.phase === 'error') {
                const cleanupError = 'Group call cleanup could not be verified. Start a group call to check again.';
                const statusLabel = this.state.errorLabel && this.state.errorLabel !== cleanupError
                    ? this.state.errorLabel : 'Group call cleanup confirmed. You can try again.';
                this.setState({...this.state, statusLabel});
            }
            return;
        }
        if (event.type === 'call.rejected') {
            for (const [key, peer] of this.connections) {
                if (peer.restartOffer && peer.restartOffer.requestID === event.request_id) {
                    this.restartOfferFailed(key, peer, this.generation, peer.restartOffer.epoch, peer.restartOffer.requestID);
                    return;
                }
            }
            if (this.observerPending && this.observerPending.requestID === event.request_id) {
                this.observerDiscoveryFailed();
                return;
            }
            const pendingCredentialRequest = this.pendingCredentials;
            if (pendingCredentialRequest && pendingCredentialRequest.requestID === event.request_id) {
                const pending = pendingCredentialRequest;
                const room = this.state.room;
                if (room && this.current(pending.generation)) this.credentialsRequestFailed(room, pending.generation, pending.attempts, pending.requestID);
                return;
            }
            if ([...this.startCancellations.values()].some(cancellation => cancellation.requestID === event.request_id)) {
                this.showStartCleanupUnverified();
                return;
            }
            const preparation = event.request_id && this.preparations.get(event.request_id);
            if (preparation) {
                this.preparations.delete(event.request_id || '');
                window.clearTimeout(preparation.timer);
                preparation.resolve();
                if (this.current(preparation.generation)) this.fail(`Group call preparation failed: ${event.payload.error}. Try again.`, event.payload.support_ref);
                return;
            }
            if (this.pendingSync?.requestID === event.request_id) {
                this.pendingSync = undefined;
                window.clearTimeout(this.syncRequestTimeout);
                this.syncRequestTimeout = undefined;
                this.recordSyncVerificationFailure();
                return;
            }
            const discovery = this.pendingDiscovery;
            if (discovery && event.request_id === discovery.requestID && this.current(discovery.generation)) {
                this.pendingDiscovery = undefined;
                window.clearTimeout(this.discoveryTimeout);
                this.discoveryTimeout = undefined;
                this.fail(`Group call discovery failed: ${event.payload.error}. Try again.`, event.payload.support_ref);
                return;
            }
            const pending = this.pendingStartOrJoin;
            if (pending && event.request_id === pending.requestID && this.current(pending.generation)) {
                this.pendingStartOrJoin = undefined;
                window.clearTimeout(this.startJoinTimeout);
                this.startJoinTimeout = undefined;
                const label = event.payload.error === 'user is already in a call'
                    ? 'You are already in a call on another connection. Leave that call before trying again.'
                    : `Group call unavailable: ${event.payload.error}`;
                if (this.isDefinitiveRoomRejection(event.payload.error)) {
                    this.rejoinableRoom = undefined;
                    this.rejoinableStateRevision = -1;
                }
                this.fail(label, event.payload.support_ref, false);
                return;
            }
            const reconciliation = this.pendingControlReconciliation;
            if (reconciliation && event.request_id === reconciliation.syncRequestID) {
                if (event.payload.support_ref) this.setState({...this.state, supportRef: event.payload.support_ref});
                window.clearTimeout(this.controlSyncTimeout);
                this.controlSyncTimeout = undefined;
                this.pendingControlReconciliation = undefined;
                this.setControlReconciliationError(reconciliation);
                return;
            }
            const control = this.pendingControl;
            if (control && event.request_id === control.requestID) {
                if (event.payload.support_ref) this.setState({...this.state, supportRef: event.payload.support_ref});
                this.pendingControl = undefined;
                if (control.failureCleanup && this.generation === control.localGeneration) {
                    this.setControlReconciliationError(control);
                } else if (this.generation === control.localGeneration && (this.state.phase === 'idle' || this.state.phase === (control.type === 'group.call.leave' ? 'left' : 'ended'))) {
                    window.clearTimeout(this.dismissTimer);
                    this.dismissTimer = undefined;
                    this.setState({...this.state, phase: this.state.phase === 'idle' ? 'ended' : this.state.phase, conversationID: control.room.conversation_id, errorLabel: controlRejectionLabel(control.type)});
                    this.reconcileRejectedControl(control);
                }
            }
            return;
        }
        if (event.type === 'group.call.credentials') {
            const pending = this.pendingCredentials;
            const room = this.state.room;
            if (!pending || !room || pending.requestID !== event.request_id || pending.generation !== this.generation || pending.roomID !== room.room_id || pending.roomGeneration !== room.generation || event.payload.conversation_id !== room.conversation_id || event.payload.room_id !== room.room_id || event.payload.generation !== room.generation) return;
            if (Date.parse(event.payload.ice_expires_at) <= Math.max(Date.now(), Date.parse(room.ice_expires_at || '') || 0)) {
                this.credentialsRequestFailed(room, pending.generation, pending.attempts, pending.requestID);
                return;
            }
            window.clearTimeout(this.credentialsTimer);
            this.pendingCredentials = undefined;
            const updated = {...room, ice_servers: event.payload.ice_servers, ice_expires_at: event.payload.ice_expires_at};
            this.clearCredentialsWarning();
            this.setState({...this.state, room: updated});
            this.scheduleCredentials(updated);
            this.updatePeerCredentials(event.payload.ice_servers);
            return;
        }
        if (event.type === 'group.call.signal') {
            void this.signal(event);
            return;
        }
        if (event.type === 'group.call.invalid_candidate') {
            const room = this.state.room;
            if (room && this.state.localStream && room.room_id === event.payload.room_id && room.generation === event.payload.generation && event.payload.from_user_id !== this.selfID) {
                const participant = {user_id: event.payload.from_user_id, device_id: event.payload.from_device_id};
                const key = this.key(participant.user_id, participant.device_id);
                if (!this.failedPeers.has(key) && (this.failedPeers.size < iceQueueLimit || room.participants.some(item => this.key(item.user_id, item.device_id) === key))) this.failIce(participant);
            }
            return;
        }
        if (event.type === 'group.call.discovered') {
            if (this.observerPending?.requestID === event.request_id) {
                this.handleObserverDiscovery(event);
                return;
            }
            const pending = this.pendingDiscovery;
            if (!pending || event.request_id !== pending.requestID || event.payload.conversation_id !== pending.conversationID || !this.current(pending.generation)) return;
            this.pendingDiscovery = undefined;
            window.clearTimeout(this.discoveryTimeout);
            this.discoveryTimeout = undefined;
            if (pending.room && (!event.payload.room || event.payload.room.room_id !== pending.room.room_id || event.payload.room.generation !== pending.room.generation || event.payload.room.status === 'ended')) {
                this.fail('The group call is no longer available.');
                return;
            }
            if (event.payload.room && pending.endedRooms.has(this.key(event.payload.room.room_id, String(event.payload.room.generation)))) {
                this.fail('The group call ended while checking. Try again.');
                return;
            }
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
        if ((event.type === 'group.call.ended' || event.payload.status === 'ended') && this.pendingDiscovery) {
            const endedRooms = this.pendingDiscovery.endedRooms;
            endedRooms.add(this.key(event.payload.room_id, String(event.payload.generation)));
            if (endedRooms.size > 64) {
                this.fail('Group call state changed while checking. Try again.');
                return;
            }
        }
        if (event.type === 'group.call.ended' && !isGroupRoomEventPayload(event.payload)) {
            if (!this.handleTerminalRoom(event.payload.room_id, event.payload.generation, event.payload.state_revision, event.payload.support_ref)) this.handleRejectedControlTerminal(event.payload.room_id, event.payload.generation, event.payload.state_revision, event.payload.support_ref);
            return;
        }
        if (!isGroupRoomEventPayload(event.payload)) return;
        const room = event.payload;
        if (event.type === 'group.call.started' && this.startAttempt && this.pendingStartOrJoin) {
            const accepted = this.acceptedStart;
            if (!accepted) {
                if (this.earlyStartedEvents.length < 32) this.earlyStartedEvents.push(event);
                return;
            }
            if (accepted.requestID !== this.pendingStartOrJoin.requestID || accepted.roomID !== room.room_id || accepted.generation !== room.generation) return;
        }
        if (room.status === 'ended' || event.type === 'group.call.ended') {
            if (!this.handleTerminalRoom(room.room_id, room.generation, room.state_revision, room.support_ref)) this.handleRejectedControlTerminal(room.room_id, room.generation, room.state_revision, room.support_ref);
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
        const startedHere = event.type === 'group.call.started' && !!this.acceptedStart && !!this.state.localStream && room.participants.some(participant => participant.user_id === this.selfID);
        // An accepted live room event supersedes an outstanding discovery snapshot.
        // Do not let its later response replace the room or initiate a second call.
        if (event.type === 'group.call.started' && this.pendingDiscovery?.generation === this.generation && this.pendingDiscovery.conversationID === room.conversation_id) {
            const discovery = this.pendingDiscovery;
            if (discovery.room && (discovery.room.room_id !== room.room_id || discovery.room.generation !== room.generation)) return;
            if (discovery.endedRooms.has(this.key(room.room_id, String(room.generation)))) return;
            this.pendingDiscovery = undefined;
            window.clearTimeout(this.discoveryTimeout);
            this.discoveryTimeout = undefined;
            if (!room.participants.some(participant => participant.user_id === discovery.selfID)) {
                this.setState(idleState);
                void this.join(room, discovery.selfID);
                return;
            }
        }
        if (this.pendingStartOrJoin && event.type === 'group.call.started' && !room.participants.some(participant => participant.user_id === this.selfID)) return;
        if (event.type === 'group.call.started' || event.type === 'group.call.participant.joined' && this.state.phase === 'joining' && room.participants.some(participant => participant.user_id === this.selfID)) {
            if (event.type === 'group.call.started' && this.pendingStartOrJoin && room.participants.some(participant => participant.user_id === this.selfID)) this.startAttempt = undefined;
            this.acceptedStart = undefined;
            this.earlyStartedEvents = [];
            this.pendingStartOrJoin = undefined;
            window.clearTimeout(this.startJoinTimeout);
            this.startJoinTimeout = undefined;
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
            this.setState({...idleState, phase: 'ringing', room, statusLabel: 'Incoming group call.'});
            this.scheduleInvitationDeadline(room, false);
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
        if (event.type === 'group.call.started') this.scheduleInvitationDeadline(room, startedHere);
        if (event.type === 'group.call.presenter.start') this.restoreRemotePresentation(room);
    }

    private handleSynced(event: GroupCallSyncedSocketEvent): void {
        const controlReconciliation = this.pendingControlReconciliation;
        if (controlReconciliation?.syncRequestID === event.request_id) {
            this.pendingControlReconciliation = undefined;
            if (this.pendingControl?.requestID === controlReconciliation.requestID) this.pendingControl = undefined;
            window.clearTimeout(this.controlSyncTimeout);
            this.controlSyncTimeout = undefined;
            const snapshot = event.payload;
            if (snapshot.room_id !== controlReconciliation.room.room_id || snapshot.generation !== controlReconciliation.room.generation ||
                this.generation !== controlReconciliation.localGeneration) {
                this.setControlReconciliationError(controlReconciliation);
                return;
            }
            if (controlReconciliation.failureCleanup) {
                if (snapshot.ownership_status === 'participant_absent') {
                    this.uncertainCleanup = undefined;
                    this.controlStateUncertain = false;
                    const errorLabel = this.state.errorLabel === cleanupUnverifiedError || this.state.errorLabel === cleanupOwnedElsewhereError
                        ? controlReconciliation.originalFailureLabel : this.state.errorLabel;
                    this.setState({...this.state, errorLabel, statusLabel: 'You are no longer in the group call. Start a group call to try again.'});
                    this.resumeDeferredIntent();
                } else if (controlReconciliation.retryCleanup && snapshot.ownership_status === 'active' &&
                    snapshot.conversation_id === controlReconciliation.room.conversation_id && snapshot.state_revision >= controlReconciliation.baselineRevision &&
                    snapshot.participants.some(participant => participant.user_id === controlReconciliation.userID && (!controlReconciliation.deviceID || participant.device_id === controlReconciliation.deviceID))) {
                    const owner = snapshot.participants.find(participant => participant.user_id === controlReconciliation.userID);
                    const control: PendingGroupCallControl = {...controlReconciliation, deviceID: controlReconciliation.deviceID || owner?.device_id || '', requestID: createRandomID()};
                    if (!this.dataProvider.ready || !this.dataProvider.send({type: 'group.call.leave', request_id: control.requestID, payload: {
                        conversation_id: control.room.conversation_id, room_id: control.room.room_id, generation: control.room.generation,
                    }})) {
                        this.setControlReconciliationError(control);
                        return;
                    }
                    this.pendingControl = control;
                    this.uncertainCleanup = control;
                    this.reconcileRejectedControl(control);
                } else {
                    this.setControlReconciliationError(controlReconciliation);
                    if (snapshot.ownership_status === 'owned_elsewhere') this.setState({...this.state, errorLabel: cleanupOwnedElsewhereError, statusLabel: 'Group call reserved on another connection. Start a group call to check again.'});
                }
                return;
            }
            if (snapshot.ownership_status !== 'active' && snapshot.ownership_status !== 'participant_absent') {
                this.setControlReconciliationError(controlReconciliation);
                return;
            }
            if (snapshot.ownership_status === 'active') {
                if (controlReconciliation.controlRetried ||
                    snapshot.conversation_id !== controlReconciliation.room.conversation_id ||
                    snapshot.state_revision < controlReconciliation.baselineRevision || !controlReconciliation.deviceID ||
                    !snapshot.participants.some(participant => participant.user_id === controlReconciliation.userID && participant.device_id === controlReconciliation.deviceID)) {
                    this.setControlReconciliationError(controlReconciliation);
                    return;
                }
                const control: PendingGroupCallControl = {...controlReconciliation, requestID: createRandomID(), controlRetried: true};
                if (!this.dataProvider.ready || !this.dataProvider.send({type: control.type, request_id: control.requestID, payload: {
                    conversation_id: control.room.conversation_id, room_id: control.room.room_id, generation: control.room.generation,
                }})) {
                    this.setControlReconciliationError(control);
                    return;
                }
                this.pendingControl = control;
                this.uncertainCleanup = control;
                this.reconcileRejectedControl(control);
                return;
            }
            if (snapshot.ownership_status === 'participant_absent' && this.deferredIntent) {
                this.uncertainCleanup = undefined;
                this.controlStateUncertain = false;
                this.setState({...idleState, phase: 'ended', statusLabel: 'You are no longer in the group call.'});
                this.resumeDeferredIntent();
                return;
            }
            if (controlReconciliation.retryCleanup) {
                if (snapshot.ownership_status === 'participant_absent') {
                    this.uncertainCleanup = undefined;
                    this.controlStateUncertain = false;
                    this.retireRoom(snapshot.room_id);
                    this.setState({...idleState, phase: 'ended', statusLabel: 'You are no longer in the group call. Start a group call to try again.'});
                    return;
                }
            }
            if (snapshot.status === 'ended') {
                if (controlReconciliation.failureCleanup) this.uncertainCleanup = undefined;
                this.retireRoom(snapshot.room_id);
                this.controlStateUncertain = false;
                this.setState({...idleState, phase: 'ended', conversationID: controlReconciliation.room.conversation_id, supportRef: controlReconciliation.room.support_ref || this.state.supportRef, statusLabel: 'The group call has ended.', errorLabel: controlReconciliation.failureCleanup ? this.state.errorLabel : controlRejectionLabel(controlReconciliation.type)});
                return;
            }
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
        if (snapshot.ownership_status === 'participant_absent') {
            this.retireRoom(snapshot.room_id);
            this.terminal('Group call ended.');
            return;
        }
        if (snapshot.ownership_status === 'owned_elsewhere') {
            this.fail('Group call is owned by another connection.', undefined, false);
            return;
        }
        if (snapshot.ownership_status !== 'active') { this.recordSyncVerificationFailure(); return; }
        if (snapshot.conversation_id !== currentRoom.conversation_id || snapshot.state_revision < this.lastAppliedStateRevision) { this.recordSyncVerificationFailure(); return; }
        // A sync cannot supply the credentials or acknowledgement needed to finish
        // joining. Wait for the correlated join event rather than adopting its roster.
        if (this.state.phase === 'joining') { this.syncVerificationFailures = 0; return; }
        const deviceID = this.selfDeviceID();
        if (!deviceID || !snapshot.participants.some(participant => participant.user_id === this.selfID && participant.device_id === deviceID)) { this.recordSyncVerificationFailure(); return; }
        this.syncVerificationFailures = 0;
        const previousPresenter = currentRoom.presenter;
        if (!sameParticipant(previousPresenter, snapshot.presenter)) {
            this.clearRemotePresentation();
            if (this.state.presentation && (snapshot.presenter?.user_id !== this.selfID || snapshot.presenter?.device_id !== this.selfDeviceID())) this.clearPresentation(false);
        }
        this.lastAppliedStateRevision = snapshot.state_revision;
        // Active sync responses are state snapshots, not call-join responses. Keep
        // the existing TURN configuration and media ownership; never depend on
        // credentials being reissued to reconcile peers and presenter state.
        const room = {...snapshot, ice_servers: currentRoom.ice_servers, ice_expires_at: currentRoom.ice_expires_at};
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
        if (this.startCancellations.size || this.controlStateUncertain || this.pendingControlReconciliation) return false;
        const knownRoom = this.state.room;
        if (knownRoom) return knownRoom.conversation_id === room.conversation_id && knownRoom.room_id === room.room_id && room.generation === knownRoom.generation && room.state_revision > this.lastAppliedStateRevision;
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
        const previous = this.state.room;
        const sameRoom = previous?.room_id === room.room_id && previous.generation === room.generation;
        const newerCredentials = !!local && !!room.ice_servers && !!room.ice_expires_at && Date.parse(room.ice_expires_at) > Date.now() && (!sameRoom || !previous.ice_expires_at || Date.parse(room.ice_expires_at) > Date.parse(previous.ice_expires_at));
        if (sameRoom && previous.ice_expires_at && (!room.ice_expires_at || Date.parse(room.ice_expires_at) <= Date.parse(previous.ice_expires_at))) room = {...room, ice_servers: previous.ice_servers, ice_expires_at: previous.ice_expires_at};
        const peers = room.participants.filter(participant => participant.user_id !== this.selfID).map(participant => this.peer(participant));
        if (this.state.localStream && peers.length) this.invitationPeerJoined = true;
        const expected = new Set(peers.map(peer => this.key(peer.userID, peer.deviceID)));
        for (const key of this.failedPeers) if (!expected.has(key)) this.failedPeers.delete(key);
        for (const [key, pending] of this.pendingSignals) {
            if (!expected.has(key) && previous?.participants.some(item => this.key(item.user_id, item.device_id) === key)) {
                for (const item of pending) window.clearTimeout(item.timer);
                this.pendingSignals.delete(key);
            }
        }
        for (const key of this.connections.keys()) {
            if (!expected.has(key)) {
                this.closePeer(key);
            }
        }
        if (newerCredentials) this.clearCredentialsWarning();
        this.setState({...this.state, room, supportRef: room.support_ref || this.state.supportRef, peers, soloPrompt: this.state.soloPrompt && peers.length === 0, phase: local ? 'active' : 'ringing', statusLabel: local ? this.credentialsFailed ? credentialsWarning : this.participantStatus(room) : 'Group call is ready to join.'});
        if (local) { this.startSyncLoop(); this.scheduleCredentials(room); }
        if (!local || !room.ice_servers) return;
        if (newerCredentials) this.updatePeerCredentials(room.ice_servers);
        for (const participant of room.participants) {
            if (participant.user_id === this.selfID) continue;
            const key = this.key(participant.user_id, participant.device_id);
            const isNewConnection = !this.connections.has(key);
            const connection = this.connectionFor(participant, room.ice_servers, generation);
            if (connection && isNewConnection && offerNewPeers && this.isOfferer(participant, room)) void this.enqueuePeerOperation(connection, async () => { await this.offer(participant, connection, generation); });
        }
    }
    private scheduleCredentials(room: GroupCallRoomPayload): void {
        if (!room.ice_expires_at || this.scheduledCredentialsExpiry === room.ice_expires_at) return;
        window.clearTimeout(this.credentialsTimer);
        this.pendingCredentials = undefined;
        this.scheduledCredentialsExpiry = room.ice_expires_at;
        const remaining = Date.parse(room.ice_expires_at) - Date.now();
        const delay = Math.max(0, remaining - Math.min(60_000, Math.max(1_000, remaining / 4)));
        const generation = this.generation;
        this.credentialsTimer = window.setTimeout(() => {
            if (delay > 2_147_483_647) {
                this.scheduledCredentialsExpiry = undefined;
                if (this.current(generation)) this.scheduleCredentials(room);
            } else this.requestCredentials(room, generation, 1);
        }, Math.min(delay, 2_147_483_647));
    }
    private requestCredentials(room: GroupCallRoomPayload, generation: number, attempts: number): void {
        const current = this.state.room;
        if (!this.current(generation) || !this.state.localStream || !current || current.room_id !== room.room_id || current.generation !== room.generation) return;
        const requestID = createRandomID();
        this.pendingCredentials = {requestID, generation, roomID: room.room_id, roomGeneration: room.generation, attempts};
        const sent = this.dataProvider.send({type: 'group.call.credentials', request_id: requestID, payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}});
        if (!sent) { this.credentialsRequestFailed(room, generation, attempts, requestID); return; }
        if (this.pendingCredentials?.requestID !== requestID) return;
        this.credentialsTimer = window.setTimeout(() => {
            if (this.pendingCredentials?.requestID !== requestID) return;
            this.credentialsRequestFailed(room, generation, attempts, requestID, true);
        }, Math.min(30_000, 2_000 * 2 ** (attempts - 1)));
    }
    private credentialsRequestFailed(room: GroupCallRoomPayload, generation: number, attempts: number, requestID: string, timedOut = false): void {
        if (this.pendingCredentials?.requestID !== requestID || !this.current(generation)) return;
        window.clearTimeout(this.credentialsTimer);
        this.pendingCredentials = undefined;
        this.credentialsFailed = true;
        this.setState({...this.state, statusLabel: credentialsWarning});
        const nextAttempt = attempts < 4 ? attempts + 1 : 1;
        const delay = attempts < 4 ? timedOut ? 0 : 2_000 * 2 ** (attempts - 1) : 30_000;
        this.credentialsTimer = window.setTimeout(() => {
            this.credentialsTimer = undefined;
            this.requestCredentials(room, generation, nextAttempt);
        }, delay);
    }
    private clearCredentialsWarning(): void {
        this.credentialsFailed = false;
        if (this.state.statusLabel === credentialsWarning) this.setState({...this.state, statusLabel: this.state.room ? this.participantStatus(this.state.room) : this.state.statusLabel});
    }
    private updatePeerCredentials(servers: ICEServer[]): void {
        const generation = this.generation;
        for (const [key, peer] of this.connections) {
            window.clearTimeout(peer.restartTimer);
            peer.restartTimer = undefined;
            if (peer.restartOffer) { peer.restartRollback = true; peer.outstandingNegotiation = undefined; }
            peer.restartOffer = undefined;
            peer.restartUpdating = true;
            const epoch = ++peer.restartEpoch;
            this.restartPeer(key, peer, generation, epoch, 1, servers);
        }
    }
    private restartPeer(key: string, peer: PeerConnectionState, generation: number, epoch: number, attempt: number, servers?: ICEServer[]): void {
        void this.enqueuePeerOperation(peer, async () => {
            const current = (): boolean => this.current(generation) && this.connections.get(key) === peer && peer.restartEpoch === epoch;
            if (!current()) return;
            let failed = false;
            try {
                if (peer.restartRollback) {
                    if (peer.connection.signalingState === 'have-local-offer' && !await this.rollbackLocalOffer(key, peer, generation)) return;
                    if (!current()) return;
                    peer.restartRollback = false;
                    peer.restartOffered = false;
                }
                if (servers) {
                    peer.connection.setConfiguration({...peer.connection.getConfiguration(), iceServers: servers});
                    peer.connection.restartIce();
                    peer.restartPending = true;
                }
                const participant = this.state.peers.find(item => this.key(item.userID, item.deviceID) === key);
                if (participant && peer.restartPending && peer.connection.signalingState === 'stable') {
                    peer.restartAttempt = attempt;
                    failed = !await this.offer({user_id: participant.userID, device_id: participant.deviceID}, peer, generation, false);
                }
            } catch { failed = true; }
            if (failed && current()) {
                this.scheduleRestartRetry(key, peer, generation, epoch, attempt, servers);
            }
        });
    }
    private restartOfferFailed(key: string, peer: PeerConnectionState, generation: number, epoch: number, requestID: string): void {
        if (!this.current(generation) || this.connections.get(key) !== peer || peer.restartEpoch !== epoch || peer.restartOffer?.requestID !== requestID) return;
        peer.restartOffer = undefined;
        peer.outstandingNegotiation = undefined;
        peer.restartOffered = false;
        peer.restartPending = true;
        this.scheduleRestartRetry(key, peer, generation, epoch, peer.restartAttempt, undefined);
    }
    private scheduleRestartRetry(key: string, peer: PeerConnectionState, generation: number, epoch: number, attempt: number, servers?: ICEServer[]): void {
        this.restartWarningActive = true;
        this.setState(this.state);
        window.clearTimeout(peer.restartTimer);
        const nextAttempt = attempt < 4 ? attempt + 1 : 1;
        const delay = attempt < 4 ? 1000 * 2 ** (attempt - 1) : 30_000;
        peer.restartTimer = window.setTimeout(() => {
            peer.restartTimer = undefined;
            void this.enqueuePeerOperation(peer, async () => {
                if (!this.current(generation) || this.connections.get(key) !== peer || peer.restartEpoch !== epoch) return;
                try {
                    if (peer.connection.signalingState === 'have-local-offer' && !await this.rollbackLocalOffer(key, peer, generation)) return;
                    if (!this.current(generation) || this.connections.get(key) !== peer || peer.restartEpoch !== epoch) return;
                    if (peer.restartPending) peer.connection.restartIce();
                    this.restartPeer(key, peer, generation, epoch, nextAttempt, servers);
                } catch {
                    if (this.current(generation) && this.connections.get(key) === peer && peer.restartEpoch === epoch) this.scheduleRestartRetry(key, peer, generation, epoch, nextAttempt, servers);
                }
            });
        }, delay);
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
        if (this.failedPeers.has(key)) return undefined;
        const existing = this.connections.get(key);
        if (existing) return existing;
        const stream = this.state.localStream;
        const room = this.state.room;
        if (!stream || !room || !this.current(generation)) return undefined;
        let connection: RTCPeerConnection | undefined;
        try {
            connection = new RTCPeerConnection({iceServers});
            const peerConnection = connection;
            const state: PeerConnectionState = {connection, generation, participant, operationQueue: Promise.resolve(), queuedOperations: 0, closed: false, cancellations: new Set(), restartPending: false, restartOffered: false, restartEpoch: 0, restartUpdating: false, restartAttempt: 1, restartRollback: false, microphoneRepairPending: false, currentIce: [], pendingIce: [], retiredIce: [], localIce: [], retiredLocalIce: [], unresolvedIce: [], unresolvedIceOverflow: false, candidates: [], signalOperations: new Set()};
            stream.getTracks().forEach(track => this.mediaSenders.set(key, peerConnection.addTrack(track, stream)));
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
                if (!event.candidate || !this.current(generation) || this.connections.get(key) !== state) return;
                try {
                    const installed = this.localIce(state);
                    const result = outgoingIceCandidate(event.candidate, installed, state.retiredLocalIce);
                    if (result.kind === 'candidate') this.sendSignal(participant, {type: 'candidate', candidate: result.candidate}, generation);
                    else if (result.kind === 'ambiguous') this.failIce(participant);
                } catch { if (this.current(generation) && this.connections.get(key) === state) this.failIce(participant); }
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
                if (!this.current(generation) || this.connections.get(key) !== state) return;
                if (peerConnection.connectionState === 'failed') this.failIce(participant);
                else if (peerConnection.connectionState === 'connected') this.confirmIceRecovery(key, state);
            };
            this.connections.set(key, state);
            void this.refreshDevices(generation);
            const pending = this.pendingSignals.get(key);
            if (pending) {
                this.pendingSignals.delete(key);
                for (const item of pending) { window.clearTimeout(item.timer); void this.queueSignal(participant, state, item.signal, generation, item.deadline); }
            }
            return state;
        } catch {
            connection?.close();
            this.mediaSenders.delete(key);
            this.presentationSenders.delete(key);
            this.presentationAudioSenders.delete(key);
            this.fail('Group audio calls are not supported by this browser.');
            return undefined;
        }
    }
    private async signal(event: GroupCallSignalSocketEvent): Promise<void> {
        const room = this.state.room;
        if (!room || room.room_id !== event.payload.room_id || room.generation !== event.payload.generation || event.payload.from_user_id === this.selfID) return;
        const participant = {user_id: event.payload.from_user_id, device_id: event.payload.from_device_id};
        const key = this.key(participant.user_id, participant.device_id);
        if (this.failedPeers.has(key)) return;
        // A roster can lag a signal, but unrostered senders cannot grow the
        // isolated-peer set indefinitely while waiting for a later projection.
        if (this.failedPeers.size >= iceQueueLimit && !room.participants.some(item => this.key(item.user_id, item.device_id) === key)) return;
        const generation = this.generation;
        const connection = room.ice_servers ? this.connectionFor(participant, room.ice_servers, generation) : undefined;
        if (!this.current(generation)) return;
        if (!connection) {
            const pending = this.pendingSignals.get(key) || [];
            if ([...this.pendingSignals.values()].reduce((count, items) => count + items.length, 0) >= iceQueueLimit) { this.failIce(participant); return; }
            const timer = window.setTimeout(() => { if (this.current(generation)) this.failIce(participant); }, iceQueueTimeout);
            pending.push({signal: event.payload.signal, timer, deadline: Date.now() + iceQueueTimeout});
            this.pendingSignals.set(key, pending);
            return;
        }
        await this.queueSignal(participant, connection, event.payload.signal, generation);
    }
    private queueSignal(participant: GroupCallParticipant, state: PeerConnectionState, signal: GroupCallSignal, generation: number, deadline = Date.now() + iceQueueTimeout): Promise<void> {
        const key = this.key(participant.user_id, participant.device_id);
        const current = (): boolean => this.current(generation) && this.connections.get(key) === state;
        if (!current()) return Promise.resolve();
        if (state.candidates.length + state.signalOperations.size >= iceQueueLimit) {
            if (current()) this.failIce(participant);
            return Promise.resolve();
        }
        const timer = window.setTimeout(() => { if (current()) this.failIce(participant); }, Math.max(0, deadline - Date.now()));
        state.signalOperations.add(timer);
        return this.enqueuePeerOperation(state, () => this.applySignal(participant, state, signal, generation, deadline))
            .finally(() => { window.clearTimeout(timer); state.signalOperations.delete(timer); });
    }
    private failIce(participant: GroupCallParticipant): void {
        const key = this.key(participant.user_id, participant.device_id);
        this.failedPeers.add(key);
        this.removePeer(participant);
        this.setState({...this.state, statusLabel: iceFailure, errorLabel: iceFailure});
    }
    private confirmIceRecovery(key: string, state: PeerConnectionState): void {
        // Overflow loses identity evidence, so only peer teardown/rejoin can
        // safely clear that warning. SDP alone never replaces a lost candidate.
        if (state.unresolvedIceOverflow || !state.unresolvedIce.length || state.connection.connectionState !== 'connected' || state.connection.signalingState !== 'stable' ||
            state.unresolvedIce.some(item => !item.replacementApplied || !matchesIceGeneration(item.identity, state.currentIce))) return;
        state.unresolvedIce.length = 0;
        if (!this.uncertainPeers.delete(key)) return;
        this.setState({...this.state, statusLabel: this.state.room ? this.participantStatus(this.state.room) : this.state.statusLabel});
    }
    private recordReplacementCandidate(state: PeerConnectionState, identity: IceCandidateIdentity, candidate: RTCIceCandidateInit): void {
        if (!candidate.candidate || state.unresolvedIceOverflow || !state.unresolvedIce.length) return;
        const installed = [...state.currentIce, ...state.pendingIce];
        for (const item of state.unresolvedIce) {
            if (installed.some(generation => matchesIceGeneration(item.identity, [generation]) && matchesIceGeneration(identity, [generation]))) item.replacementApplied = true;
        }
        this.confirmIceRecovery(this.key(state.participant.user_id, state.participant.device_id), state);
    }
    private async applySignal(participant: GroupCallParticipant, state: PeerConnectionState, signal: GroupCallSignal, generation: number, deadline = Date.now() + iceQueueTimeout): Promise<void> {
        const key = this.key(participant.user_id, participant.device_id);
        const current = (): boolean => this.current(generation) && state.generation === generation && this.connections.get(key) === state;
        if (!current()) return;
        try {
            if (signal.type === 'candidate') {
                const parsed = iceCandidateIdentity(signal.candidate);
                if (!parsed) throw new Error('Ambiguous ICE candidate');
                if (Date.now() >= deadline) throw new Error('ICE candidate expired');
                await this.acceptCandidate(participant, state, parsed.candidate, parsed.identity, current, deadline);
                return;
            }
            if (signal.type === 'offer') {
                const room = this.state.room;
                // The initial offerer is also the impolite peer for every later
                // negotiation, so two simultaneous restarts cannot both roll back.
                if (state.connection.signalingState !== 'stable' && room && this.isOfferer(participant, room)) {
                    this.retireIce(state, iceGenerations(signal.sdp));
                    await this.flushCandidates(state, current);
                    return;
                }
                state.outstandingNegotiation = undefined;
                if (state.connection.signalingState !== 'stable') {
                    if (!await this.rollbackLocalOffer(key, state, generation)) return;
                    if (state.restartOffered) {
                        window.clearTimeout(state.restartTimer);
                        state.restartTimer = undefined;
                        state.restartOffer = undefined;
                        state.restartPending = true;
                        state.restartOffered = false;
                    }
                }
                await state.connection.setRemoteDescription({type: 'offer', sdp: signal.sdp});
                if (!current()) return;
                state.pendingIce = iceGenerations(state.connection.pendingRemoteDescription?.sdp || '');
                await this.flushCandidates(state, current);
                if (!current()) return;
                const answer = await state.connection.createAnswer();
                if (!current()) return;
                await state.connection.setLocalDescription(answer);
                if (!current()) return;
                this.rememberLocalIce(state);
                this.retireIce(state, state.currentIce);
                state.currentIce = state.pendingIce;
                state.pendingIce = [];
                this.confirmIceRecovery(key, state);
                if (answer.sdp && current()) this.sendSignal(participant, {type: 'answer', sdp: answer.sdp, negotiation_id: signal.negotiation_id}, generation);
                if (current() && !state.restartPending) await this.repairMicrophoneAfterRollback(key, state, generation);
            } else if (signal.type === 'answer' && state.connection.signalingState === 'have-local-offer') {
                if (!state.outstandingNegotiation || signal.negotiation_id !== state.outstandingNegotiation) return;
                await state.connection.setRemoteDescription({type: 'answer', sdp: signal.sdp});
                if (!current()) return;
                await this.repairMicrophoneAfterRollback(key, state, generation);
                if (!current()) return;
                this.retireIce(state, state.currentIce);
                state.currentIce = iceGenerations(state.connection.currentRemoteDescription?.sdp || '');
                state.pendingIce = [];
                state.outstandingNegotiation = undefined;
                if (state.restartOffer?.epoch === state.restartEpoch) {
                    window.clearTimeout(state.restartTimer);
                    state.restartTimer = undefined;
                    state.restartOffer = undefined;
                    state.restartUpdating = false;
                    this.setState(this.state);
                }
                state.restartOffered = false;
                await this.flushCandidates(state, current);
                if (current()) this.confirmIceRecovery(key, state);
            }
            if (state.restartPending && state.connection.signalingState === 'stable') {
                window.clearTimeout(state.restartTimer);
                state.restartTimer = undefined;
                this.restartPeer(key, state, generation, state.restartEpoch, 1, undefined);
            }
        } catch { if (current()) this.failIce(participant); }
    }
    private retireIce(state: PeerConnectionState, generations: readonly IceMediaGeneration[]): void {
        for (const generation of generations) {
            if (!state.retiredIce.some(item => item.ufrag === generation.ufrag && item.mid === generation.mid && item.index === generation.index && item.password === generation.password)) state.retiredIce.push(generation);
        }
        if (state.retiredIce.length > iceQueueLimit) state.retiredIce.splice(0, state.retiredIce.length - iceQueueLimit);
    }
    private async acceptCandidate(participant: GroupCallParticipant, state: PeerConnectionState, candidate: RTCIceCandidateInit, identity: IceCandidateIdentity, current: () => boolean, deadline: number): Promise<void> {
        const installed = [...state.currentIce, ...state.pendingIce];
        this.assertUnambiguousIce(identity, [...installed, ...state.retiredIce]);
        if (matchesIceGeneration(identity, installed)) {
            await state.connection.addIceCandidate(candidate);
            if (current()) this.recordReplacementCandidate(state, identity, candidate);
            return;
        }
        if (matchesIceGeneration(identity, state.retiredIce)) return;
        if ([...installed, ...state.retiredIce].some(item => item.ufrag === identity.ufrag)) throw new Error('ICE media identity mismatch');
        if (state.candidates.length >= iceQueueLimit) throw new Error('ICE queue exhausted');
        const timer = window.setTimeout(() => {
            if (!current()) return;
            const index = state.candidates.findIndex(item => item.timer === timer);
            if (index < 0) return;
            state.candidates.splice(index, 1);
            if (state.connection.connectionState !== 'connected' && (!state.currentIce.length || state.connection.signalingState !== 'stable' || state.outstandingNegotiation)) this.failIce(participant);
            else {
                // A bounded history cannot distinguish an evicted stale ufrag
                // from a future offer that never arrived. Keep a healthy peer,
                // but retain a bounded, actionable warning until it resolves.
                const existing = state.unresolvedIce.find(item => item.identity.ufrag === identity.ufrag && item.identity.mid === identity.mid && item.identity.index === identity.index);
                if (existing) existing.replacementApplied = false;
                else if (state.unresolvedIce.length < iceQueueLimit) state.unresolvedIce.push({identity, replacementApplied: false});
                else state.unresolvedIceOverflow = true;
                this.uncertainPeers.add(this.key(participant.user_id, participant.device_id));
                this.setState(this.state);
            }
        }, Math.max(0, deadline - Date.now()));
        state.candidates.push({candidate, identity, timer});
    }
    private async flushCandidates(state: PeerConnectionState, current: () => boolean): Promise<void> {
        for (const pending of [...state.candidates]) {
            if (!current()) return;
            const installed = [...state.currentIce, ...state.pendingIce];
            this.assertUnambiguousIce(pending.identity, [...installed, ...state.retiredIce]);
            if (!matchesIceGeneration(pending.identity, installed) && !matchesIceGeneration(pending.identity, state.retiredIce)) {
                if ([...installed, ...state.retiredIce].some(item => item.ufrag === pending.identity.ufrag)) throw new Error('ICE media identity mismatch');
                continue;
            }
            state.candidates.splice(state.candidates.indexOf(pending), 1);
            window.clearTimeout(pending.timer);
            if (matchesIceGeneration(pending.identity, installed)) {
                await state.connection.addIceCandidate(pending.candidate);
                if (current()) this.recordReplacementCandidate(state, pending.identity, pending.candidate);
            }
        }
    }
    private assertUnambiguousIce(identity: IceCandidateIdentity, generations: readonly IceMediaGeneration[]): void {
        const matching = generations.filter(item => matchesIceGeneration(identity, [item]));
        if (new Set(matching.map(item => item.password)).size > 1) throw new Error('ICE credentials are ambiguous');
    }
    private localIce(state: PeerConnectionState): IceMediaGeneration[] {
        return [state.connection.currentLocalDescription, state.connection.pendingLocalDescription]
            .reduce<IceMediaGeneration[]>((all, description) => all.concat(iceGenerations(description?.sdp || '')), []);
    }
    private rememberLocalIce(state: PeerConnectionState): void {
        const installed = this.localIce(state);
        for (const previous of state.localIce) {
            if (!installed.some(item => item.mid === previous.mid && item.index === previous.index && item.ufrag === previous.ufrag && item.password === previous.password) &&
                !state.retiredLocalIce.some(item => item.mid === previous.mid && item.index === previous.index && item.ufrag === previous.ufrag && item.password === previous.password)) state.retiredLocalIce.push(previous);
        }
        if (state.retiredLocalIce.length > iceQueueLimit) state.retiredLocalIce.splice(0, state.retiredLocalIce.length - iceQueueLimit);
        state.localIce = installed;
    }
    private async rollbackLocalOffer(key: string, state: PeerConnectionState, generation: number): Promise<boolean> {
        await state.connection.setLocalDescription({type: 'rollback'});
        // A newer restart epoch may already be queued on the same connection.
        // Preserve the actual rollback's repair and ICE history for that epoch.
        if (!this.current(generation) || this.connections.get(key) !== state) return false;
        state.microphoneRepairPending = true;
        this.rememberLocalIce(state);
        return true;
    }
    private async repairMicrophoneAfterRollback(key: string, state: PeerConnectionState, generation: number): Promise<void> {
        if (!state.microphoneRepairPending) return;
        const sender = this.mediaSenders.get(key);
        const track = sender?.track;
        if (!sender || !track || track.kind !== 'audio' || isEndedTrack(track)) throw new Error('Microphone sender unavailable after rollback.');
        // Chromium can retain a live, sendrecv sender while its audio source
        // stops following rollback. Reattach only after negotiation is stable;
        // rebinding before the answer does not repair that native failure.
        await this.replaceTrack(key, sender, null, generation, true);
        if (!this.current(generation) || this.connections.get(key) !== state || this.mediaSenders.get(key) !== sender) return;
        if (isEndedTrack(track)) throw new Error('Microphone ended during rollback repair.');
        await this.replaceTrack(key, sender, track, generation, true);
        if (!this.current(generation) || this.connections.get(key) !== state || this.mediaSenders.get(key) !== sender) return;
        if (isEndedTrack(track) || sender.track !== track) throw new Error('Microphone unavailable after rollback repair.');
        state.microphoneRepairPending = false;
    }
    private async offer(participant: GroupCallParticipant, state: PeerConnectionState, generation: number, removeOnFailure = true): Promise<boolean> {
        const key = this.key(participant.user_id, participant.device_id);
        if (!this.current(generation) || this.connections.get(key) !== state || state.connection.signalingState !== 'stable') return false;
        const restartEpoch = state.restartEpoch;
        try {
            const offer = await state.connection.createOffer();
            if (!this.current(generation) || this.connections.get(key) !== state) return false;
            if (state.restartEpoch !== restartEpoch) return false;
            await state.connection.setLocalDescription(offer);
            if (!this.current(generation) || this.connections.get(key) !== state) return false;
            this.rememberLocalIce(state);
            if (state.restartEpoch !== restartEpoch) {
                state.restartRollback = true;
                return false;
            }
            state.restartOffered = state.restartPending;
            state.restartPending = false;
            const negotiationID = createNegotiationID();
            state.outstandingNegotiation = negotiationID;
            if (state.restartOffered && state.restartEpoch === restartEpoch) {
                const room = this.state.room;
                if (!offer.sdp || !room || !isPositiveGeneration(room.generation)) { state.outstandingNegotiation = undefined; state.restartPending = true; return false; }
                const requestID = createRandomID();
                state.restartOffer = {requestID, epoch: restartEpoch};
                const sent = this.dataProvider.send({type: 'group.call.signal', request_id: requestID, payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation, target_user_id: participant.user_id, target_device_id: participant.device_id, signal: {type: 'offer', sdp: offer.sdp, negotiation_id: negotiationID}}});
                if (!sent) { state.outstandingNegotiation = undefined; state.restartOffer = undefined; state.restartOffered = false; state.restartPending = true; return false; }
                if (state.restartOffer?.requestID === requestID) {
                    window.clearTimeout(state.restartTimer);
                    state.restartTimer = window.setTimeout(() => this.restartOfferFailed(key, state, generation, restartEpoch, requestID), 8_000);
                }
            } else if (offer.sdp && this.current(generation) && this.connections.get(key) === state) this.sendSignal(participant, {type: 'offer', sdp: offer.sdp, negotiation_id: negotiationID}, generation);
            else state.outstandingNegotiation = undefined;
            return true;
        } catch {
            if (removeOnFailure && this.current(generation) && this.connections.get(key) === state) {
                if (this.uncertainPeers.has(key)) this.failIce(participant);
                else this.removePeer(participant);
            }
            return false;
        }
    }
    private async offerParticipant(key: string, state: PeerConnectionState, generation: number): Promise<void> {
        const peer = this.state.peers.find(item => this.key(item.userID, item.deviceID) === key);
        if (peer) await this.offer({user_id: peer.userID, device_id: peer.deviceID}, state, generation);
    }
    private sendSignal(target: GroupCallParticipant, signal: GroupCallSignal, generation: number): void {
        const room = this.state.room;
        if (!room || !isPositiveGeneration(room.generation) || !this.current(generation)) return;
        this.send({type: 'group.call.signal', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation, target_user_id: target.user_id, target_device_id: target.device_id, signal}}, generation);
    }
    private removePeer(participant: GroupCallParticipant): void {
        const key = this.key(participant.user_id, participant.device_id);
        this.closePeer(key);
        this.setState({...this.state, peers: this.state.peers.filter(peer => this.key(peer.userID, peer.deviceID) !== key)});
    }
    private closePeer(key: string): void {
        this.uncertainPeers.delete(key);
        const state = this.connections.get(key);
        if (state) { state.closed = true; for (const cancel of state.cancellations) cancel(); }
        for (const pending of this.pendingSignals.get(key) || []) window.clearTimeout(pending.timer);
        this.pendingSignals.delete(key);
        for (const pending of this.connections.get(key)?.candidates || []) window.clearTimeout(pending.timer);
        for (const timer of this.connections.get(key)?.signalOperations || []) window.clearTimeout(timer);
        window.clearTimeout(this.connections.get(key)?.restartTimer);
        this.connections.get(key)?.connection.close();
        this.connections.delete(key);
        this.clearRemotePresentationForPeer(key);
        this.mediaSenders.delete(key); this.presentationSenders.delete(key); this.presentationAudioSenders.delete(key);
    }
    private async microphone(generation: number): Promise<MediaStream | undefined> {
        if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function') { this.fail('Microphone access is unavailable.'); return undefined; }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: true});
            if (!this.current(generation)) { this.stop(stream); return undefined; }
            return stream;
        } catch { if (this.current(generation)) this.fail('Microphone permission was denied. Allow microphone access for this site and try again.'); return undefined; }
    }
    private send(event: Parameters<DataProviderService['send']>[0], generation: number): boolean {
        if (!this.current(generation) || this.dataProvider.send(event)) return this.current(generation);
        this.fail('The secure connection is unavailable.', undefined, event.type !== 'group.call.leave' && event.type !== 'group.call.end');
        return false;
    }
    private isDefinitiveRoomRejection(error: string): boolean {
        return error === 'call not found' || error === 'call not allowed' || error === 'call is not a group call';
    }
    private handleTerminalRoom(roomID: string, roomGeneration: number, revision: number, supportRef?: string): boolean {
        const room = this.state.room || this.rejoinableRoom || this.pendingControl?.room || this.pendingControlReconciliation?.room || this.uncertainCleanup?.room;
        if (!room || room.room_id !== roomID || room.generation !== roomGeneration) return false;
        const knownRevision = this.state.room?.room_id === roomID ? this.lastAppliedStateRevision
            : this.rejoinableRoom?.room_id === roomID ? this.rejoinableStateRevision
                : this.pendingControl?.room.room_id === roomID ? this.pendingControl.baselineRevision
                    : this.pendingControlReconciliation?.baselineRevision ?? this.uncertainCleanup?.baselineRevision ?? -1;
        if (revision <= knownRevision) return false;
        this.lastAppliedStateRevision = revision;
        this.retireRoom(roomID);
        if (this.deferredIntent && (this.pendingControl || this.pendingControlReconciliation || this.uncertainCleanup)) {
            // A room projection does not establish this connection's reservation ownership.
            // Keep the correlated control check and user intent alive until absence is confirmed.
            this.rejoinableRoom = undefined;
            this.rejoinableStateRevision = -1;
            this.setState({...idleState, phase: 'ended', conversationID: room.conversation_id, supportRef: supportRef || room.support_ref || this.state.supportRef, statusLabel: 'Group call ended.'});
            return true;
        }
        this.terminal('Group call ended.', true, false, roomID, supportRef);
        return true;
    }
    private handleRejectedControlTerminal(roomID: string, roomGeneration: number, revision: number, supportRef?: string): void {
        const control = this.pendingControlReconciliation;
        if (!control || control.room.room_id !== roomID || control.room.generation !== roomGeneration || this.generation !== control.localGeneration) return;
        if (!control.hasAdvancedRevision || revision <= control.baselineRevision) return;
        this.pendingControlReconciliation = undefined;
        window.clearTimeout(this.controlSyncTimeout);
        this.controlSyncTimeout = undefined;
        this.retireRoom(roomID);
        this.setState({...idleState, phase: 'ended', conversationID: control.room.conversation_id, supportRef: supportRef || control.room.support_ref || this.state.supportRef, statusLabel: 'The group call has ended.', errorLabel: controlRejectionLabel(control.type)});
    }
    private reconcileRejectedControl(control: PendingGroupCallControl, retryCleanup = false): void {
        if (this.pendingControlReconciliation || this.generation !== control.localGeneration) return;
        const syncRequestID = createRandomID();
        const reconciliation: PendingControlReconciliation = {...control, syncRequestID, hasAdvancedRevision: false, retryCleanup};
        this.pendingControlReconciliation = reconciliation;
        if (!this.dataProvider.send({type: 'group.call.sync', request_id: syncRequestID, payload: {
            conversation_id: control.room.conversation_id, room_id: control.room.room_id, generation: control.room.generation, ownership_status: true,
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
        const label = control.failureCleanup ? 'Group call cleanup could not be verified.' : controlRejectionLabel(control.type);
        if (control.localGeneration !== this.generation) return;
        window.clearTimeout(this.controlSyncTimeout);
        this.controlSyncTimeout = undefined;
        this.pendingControlReconciliation = undefined;
        this.uncertainCleanup = control;
        if (control.failureCleanup) {
            this.pendingControl = undefined;
        }
        this.controlStateUncertain = true;
        const retry = ' Start a group call to check again.';
        this.setState({...this.state, errorLabel: control.failureCleanup ? cleanupUnverifiedError : `${label} The current room state could not be verified.${retry}`, statusLabel: `${label} Room status could not be verified.${retry}`});
    }
    private terminal(label: string, dismiss = true, retireCurrentRoom = true, roomToRetire?: string, supportRef?: string): void {
        this.stopObserverDiscovery();
        window.clearTimeout(this.credentialsTimer);
        this.credentialsTimer = undefined;
        this.pendingCredentials = undefined;
        this.scheduledCredentialsExpiry = undefined;
        this.credentialsFailed = false;
        this.restartWarningActive = false;
        window.clearTimeout(this.invitationTimer);
        this.invitationTimer = undefined;
        const attempt = this.startAttempt;
        this.startAttempt = undefined;
        if (attempt) this.cancelStartAttempt(attempt.conversationID, attempt.attemptID);
        this.deferredIntent = undefined;
        const terminalConversationID = this.state.room?.conversation_id ?? this.conversationID ?? this.rejoinableRoom?.conversation_id ?? this.state.conversationID;
        this.pendingDiscovery = undefined;
        window.clearTimeout(this.discoveryTimeout);
        this.discoveryTimeout = undefined;
        this.pendingStartOrJoin = undefined;
        window.clearTimeout(this.startJoinTimeout);
        this.startJoinTimeout = undefined;
        this.pendingControl = undefined;
        this.pendingControlReconciliation = undefined;
        this.uncertainCleanup = undefined;
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
        this.inputOperationQueue = Promise.resolve();
        this.presentationOperationQueue = Promise.resolve();
        if (this.presentationCapture) {
            this.presentationCapture.stopping = true;
            this.presentationCapture.active = false;
            if (this.presentationCapture.stream !== this.state.presentation) this.stop(this.presentationCapture.stream);
            this.presentationCapture = undefined;
        }
        for (const state of this.connections.values()) { state.closed = true; for (const cancel of state.cancellations) cancel(); window.clearTimeout(state.restartTimer); for (const pending of state.candidates) window.clearTimeout(pending.timer); for (const timer of state.signalOperations) window.clearTimeout(timer); state.connection.close(); }
        for (const pending of this.pendingMicrophones) this.stop(pending);
        this.pendingMicrophones.clear();
        for (const signals of this.pendingSignals.values()) for (const pending of signals) window.clearTimeout(pending.timer);
        this.connections.clear(); this.failedPeers.clear(); this.uncertainPeers.clear(); this.remotePresentationReceivers.clear(); this.pendingSignals.clear(); this.mediaSenders.clear(); this.presentationSenders.clear(); this.presentationAudioSenders.clear(); this.stop(this.state.localStream); this.stop(this.state.presentation);
        if (this.deviceListener) navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceListener);
        this.deviceListener = undefined;
        for (const audio of this.remoteAudios) { audio.pause(); audio.srcObject = null; }
        this.remoteAudios.clear();
        this.playbackRequestedAudios.clear();
        this.conversationID = undefined;
        this.selfID = undefined;
        this.setState({...idleState, phase: 'ended', conversationID: terminalConversationID, supportRef: supportRef || this.state.room?.support_ref || this.state.supportRef, statusLabel: label});
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
        if (this.pendingStartOrJoin && this.selfID && this.conversationID) {
            this.cancelPendingAdmission('Realtime connection lost. Your microphone has been stopped while the reservation is checked.');
            return;
        }
        const room = this.state.room && this.state.room.participants.some(participant => participant.user_id !== this.selfID)
            ? this.state.room
            : this.rejoinableRoom;
        if (!room) {
            this.fail('Realtime connection lost. Rejoin the group call after reconnecting.', undefined, false);
            return;
        }
        const revision = this.state.room?.room_id === room.room_id ? this.lastAppliedStateRevision : this.rejoinableStateRevision;
        this.terminal('Realtime connection lost. Rejoin the group call after reconnecting.', false);
        this.rejoinableRoom = room;
        this.rejoinableStateRevision = revision;
        this.setState({...idleState, phase: 'left', conversationID: room.conversation_id, supportRef: room.support_ref || this.state.supportRef, statusLabel: 'Realtime connection lost. Rejoin the group call after reconnecting.'});
    }
    private fail(label: string, supportRef?: string, leaveEstablishedRoom = true): void {
        const room = this.state.room;
        const owner = room?.participants.find(participant => participant.user_id === this.selfID);
        const cleanup = leaveEstablishedRoom && this.state.phase === 'active' && this.state.localStream && room &&
            isPositiveGeneration(room.generation) && owner ? {room, owner, revision: this.lastAppliedStateRevision} : undefined;
        const failureConversationID = this.state.room?.conversation_id ?? this.conversationID ?? this.state.conversationID;
        const failureSupportRef = supportRef || this.state.room?.support_ref || this.state.supportRef;
        const retryRoom = this.state.room && this.rejoinableRoom?.room_id === this.state.room.room_id && this.rejoinableRoom.generation === this.state.room.generation
            ? this.rejoinableRoom
            : undefined;
        const retryRevision = Math.max(this.rejoinableStateRevision, this.lastAppliedStateRevision);
        const terminalRevision = this.lastAppliedStateRevision;
        this.terminal(label, false);
        if (retryRoom) {
            this.rejoinableRoom = retryRoom;
            this.rejoinableStateRevision = Math.max(retryRevision, terminalRevision);
            this.setState({...idleState, phase: 'left', conversationID: retryRoom.conversation_id, supportRef: failureSupportRef, statusLabel: label, errorLabel: label});
            return;
        }
        this.setState({...idleState, phase: 'error', conversationID: failureConversationID, supportRef: failureSupportRef, statusLabel: label, errorLabel: label});
        if (cleanup) {
            const control: PendingGroupCallControl = {requestID: createRandomID(), type: 'group.call.leave', room: cleanup.room,
                baselineRevision: cleanup.revision, localGeneration: this.generation, userID: cleanup.owner.user_id,
                deviceID: cleanup.owner.device_id, failureCleanup: true, originalFailureLabel: label};
            this.controlStateUncertain = true;
            this.uncertainCleanup = control;
            if (!this.dataProvider.ready || !this.dataProvider.send({type: 'group.call.leave', request_id: control.requestID, payload: {
                conversation_id: cleanup.room.conversation_id, room_id: cleanup.room.room_id, generation: cleanup.room.generation,
            }})) {
                this.setControlReconciliationError(control);
                return;
            }
            this.pendingControl = control;
            this.reconcileRejectedControl(control);
        }
    }
    private resumeDeferredIntent(): void {
        const intent = this.deferredIntent;
        this.deferredIntent = undefined;
        if (intent && this.dataProvider.ready && intent.generation === this.generation) this.discover(intent.conversationID, intent.selfID, intent.room);
    }
    private prepareStart(conversationID: string, generation: number): Promise<string | undefined> {
        const requestID = createRandomID();
        return new Promise<string | undefined>(resolve => {
            const timer = window.setTimeout(() => {
                const preparation = this.preparations.get(requestID);
                if (!preparation) return;
                resolve(undefined);
                if (this.current(generation)) this.fail('Group call preparation timed out. Try again.');
                // A delayed response can still be fenced, but permits expire on the server.
                preparation.timer = window.setTimeout(() => this.preparations.delete(requestID), 40_000);
            }, 8_000);
            this.preparations.set(requestID, {generation, conversationID, resolve, timer});
            if (!this.dataProvider.send({type: 'group.call.prepare_start', request_id: requestID, payload: {conversation_id: conversationID}})) {
                window.clearTimeout(timer);
                this.preparations.delete(requestID);
                resolve(undefined);
                if (this.current(generation)) this.fail('The secure connection is unavailable.');
            }
        });
    }
    private cancelStartAttempt(conversationID: string, attemptID: string): void {
        if (this.startCancellations.has(attemptID)) return;
        this.startCancellations.set(attemptID, {conversationID, requestID: createRandomID(), sends: 0, deadline: Date.now() + 30_000});
        this.retryStartCancellation(attemptID);
    }
    private retryStartCancellation(attemptID: string): void {
        const cancellation = this.startCancellations.get(attemptID);
        if (!cancellation) return;
        if (Date.now() >= cancellation.deadline) {
            window.clearTimeout(cancellation.timer);
            cancellation.timer = undefined;
            this.showStartCleanupUnverified();
            return;
        }
        if (cancellation.sends >= 4) return;
        window.clearTimeout(cancellation.timer);
        if (this.dataProvider.ready) {
            cancellation.sends += 1;
            this.dataProvider.send({type: 'group.call.cancel_start', request_id: cancellation.requestID, payload: {conversation_id: cancellation.conversationID, attempt_id: attemptID}});
        }
        if (this.startCancellations.get(attemptID) === cancellation) {
            const delay = cancellation.sends >= 4 ? cancellation.deadline - Date.now() : Math.min(8_000, cancellation.deadline - Date.now());
            cancellation.timer = window.setTimeout(() => this.retryStartCancellation(attemptID), delay);
        }
    }
    private showStartCleanupUnverified(): void {
        const label = 'Group call cleanup could not be verified. Start a group call to check again.';
        this.setState({...this.state, phase: 'error', statusLabel: label, errorLabel: label});
    }
    private armStartJoinTimeout(requestID: string, generation: number, conversationID: string, selfID: string, room?: GroupCallRoomPayload): void {
        if (this.pendingStartOrJoin?.requestID !== requestID) return;
        this.startJoinTimeout = window.setTimeout(() => {
            if (this.pendingStartOrJoin?.requestID !== requestID || !this.current(generation)) return;
            const label = 'Group call request timed out. Your microphone has been stopped while the reservation is checked.';
            this.terminal(label, false);
            this.setState({...idleState, phase: 'error', conversationID, statusLabel: label, errorLabel: label});
            if (room) this.beginUncertainAdmissionCleanup(room, selfID);
            // Start is fenced by the server-issued attempt; terminal queues its cancellation.
        }, 8_000);
    }
    private cancelPendingAdmission(label: string): void {
        const room = this.state.room;
        const selfID = this.selfID;
        const conversationID = this.conversationID;
        if (!selfID || !conversationID) return;
        this.terminal(label, false);
        this.setState({...idleState, phase: 'error', conversationID, statusLabel: label, errorLabel: label});
        if (room) this.beginUncertainAdmissionCleanup(room, selfID);
        // A start attempt is cancelled by terminal; joins still reconcile the exact room.
    }
    private beginUncertainAdmissionCleanup(room: GroupCallRoomPayload, selfID: string): void {
        const control: PendingGroupCallControl = {requestID: createRandomID(), type: 'group.call.leave', room,
            baselineRevision: -1, localGeneration: this.generation, userID: selfID, deviceID: '', failureCleanup: true,
            originalFailureLabel: this.state.errorLabel};
        this.controlStateUncertain = true;
        this.uncertainCleanup = control;
        if (this.dataProvider.ready) this.reconcileRejectedControl(control, true);
        else this.setControlReconciliationError(control);
    }
    private beginGeneration(selfID: string, conversationID: string): number { this.stopObserverDiscovery(); window.clearTimeout(this.invitationTimer); this.invitationTimer = undefined; this.deferredIntent = undefined; window.clearTimeout(this.dismissTimer); this.dismissTimer = undefined; this.screenShareAudioEnabled = false; this.stopSyncLoop(); this.remotePresentationReceivers.clear(); this.pendingControl = undefined; this.pendingControlReconciliation = undefined; window.clearTimeout(this.controlSyncTimeout); this.controlSyncTimeout = undefined; this.lastAppliedStateRevision = -1; this.generation += 1; this.selfID = selfID; this.conversationID = conversationID; return this.generation; }
    private current(generation: number): boolean { return generation === this.generation; }
    private canStart(): boolean {
        if (this.startCancellations.size) {
            for (const [attemptID, cancellation] of this.startCancellations) {
                if (cancellation.timer === undefined) {
                    cancellation.requestID = createRandomID();
                    cancellation.sends = 0;
                    cancellation.deadline = Date.now() + 30_000;
                    this.retryStartCancellation(attemptID);
                }
            }
            return false;
        }
        if (this.preparations.size) return false;
        if (this.startAttempt || this.pendingStartOrJoin) return false;
        if (this.pendingControl) {
            if (this.dataProvider.ready && !this.pendingControlReconciliation && !this.controlStateUncertain) {
                this.setState({...this.state, statusLabel: 'Checking the previous group call reservation…'});
                this.reconcileRejectedControl(this.pendingControl);
            }
            return false;
        }
        return !this.controlStateUncertain && !this.pendingControlReconciliation && ['idle', 'left', 'ended', 'error', 'ringing'].includes(this.state.phase);
    }
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
    private async replaceTrack(key: string, sender: RTCRtpSender, track: MediaStreamTrack | null, generation = this.generation, critical = false): Promise<void> {
        let timeout: number | undefined;
        const owner = this.connections.get(key);
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
            if (this.current(generation) && owner && this.connections.get(key) === owner) {
                const participant = this.state.peers.find(peer => this.key(peer.userID, peer.deviceID) === key);
                if (participant && (critical || this.uncertainPeers.has(key))) this.failIce({user_id: participant.userID, device_id: participant.deviceID});
                else {
                    if (participant) this.removePeer({user_id: participant.userID, device_id: participant.deviceID});
                    this.setState({...this.state, errorLabel: 'A peer connection was closed because media could not be replaced.'});
                }
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
    private enqueuePeerOperation(state: PeerConnectionState, operation: () => Promise<void>, failOnClose = false): Promise<void> {
        const key = this.key(state.participant.user_id, state.participant.device_id);
        if (state.queuedOperations >= iceQueueLimit) {
            if (this.current(state.generation) && this.connections.get(key) === state) this.failIce(state.participant);
            return failOnClose ? Promise.reject(new Error('Peer operation queue exhausted.')) : Promise.resolve();
        }
        state.queuedOperations += 1;
        const run = (): Promise<void> => new Promise((resolve, reject) => {
            let finished = false;
            const finish = (failed: boolean, error?: unknown): void => {
                if (finished) return;
                finished = true;
                state.cancellations.delete(cancel);
                if (failed) reject(error); else resolve();
            };
            const cancel = (): void => finish(failOnClose, failOnClose ? new Error('Peer closed during presentation setup.') : undefined);
            if (state.closed) { cancel(); return; }
            state.cancellations.add(cancel);
            try { operation().then(() => finish(false), error => finish(true, error)); }
            catch (error) { finish(true, error); }
        });
        const queued = state.operationQueue.then(run, run);
        state.operationQueue = queued.catch(() => undefined);
        return queued.finally(() => { state.queuedOperations -= 1; });
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
            await Promise.all([...this.presentationAudioSenders].map(([key, sender]) => {
                const peer = this.connections.get(key);
                return peer ? this.enqueuePeerOperation(peer, async () => {
                    if (!this.current(capture.generation) || this.connections.get(key) !== peer) return;
                    await this.replaceTrack(key, sender, null, capture.generation).catch(() => undefined);
                    await this.offerParticipant(key, peer, capture.generation);
                }) : Promise.resolve();
            }));
            if (this.presentationCapture === capture && this.current(capture.generation) && !capture.stopping) {
                capture.audioStopping = false;
                this.setState({...this.state, screenShareAudioActive: false, shareTransitioning: false, statusLabel: 'System audio stopped. Your presentation is still visible.'});
            }
        })();
    }
    private async detachPresentationSenders(generation: number, renegotiate: boolean): Promise<void> {
        const keys = new Set([...this.presentationSenders.keys(), ...this.presentationAudioSenders.keys()]);
        await Promise.all([...keys].map(key => {
            const peer = this.connections.get(key);
            return peer ? this.enqueuePeerOperation(peer, async () => {
                if (!this.current(generation) || this.connections.get(key) !== peer) return;
                const videoSender = this.presentationSenders.get(key);
                const audioSender = this.presentationAudioSenders.get(key);
                await Promise.all([
                    videoSender ? this.replaceTrack(key, videoSender, null, generation).catch(() => undefined) : Promise.resolve(),
                    audioSender ? this.replaceTrack(key, audioSender, null, generation).catch(() => undefined) : Promise.resolve(),
                ]);
                if (renegotiate) await this.offerParticipant(key, peer, generation);
            }) : Promise.resolve();
        }));
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
    private observerRoom(): GroupCallRoomPayload | undefined {
        return this.state.phase === 'ringing' && !this.state.localStream ? this.state.room : undefined;
    }
    private stopObserverDiscovery(): void {
        window.clearTimeout(this.observerTimer);
        this.observerTimer = undefined;
        this.observerPending = undefined;
        this.observerFailures = 0;
        this.observerUnknown = false;
    }
    private scheduleObserverDiscovery(delay: number): void {
        if (!this.observerRoom() || !this.dataProvider.ready || this.observerTimer !== undefined || this.observerPending) return;
        this.observerTimer = window.setTimeout(() => {
            this.observerTimer = undefined;
            const room = this.observerRoom();
            if (!room || !this.dataProvider.ready) return;
            const requestID = createRandomID();
            const pending = {requestID, generation: this.generation, conversationID: room.conversation_id, roomID: room.room_id, roomGeneration: room.generation, revision: this.lastAppliedStateRevision};
            this.observerPending = pending;
            const sent = this.dataProvider.send({type: 'group.call.discover', request_id: requestID, payload: {conversation_id: room.conversation_id}});
            if (!sent) { this.observerDiscoveryFailed(); return; }
            if (this.observerPending !== pending) return;
            this.observerTimer = window.setTimeout(() => this.observerDiscoveryFailed(), 8_000);
        }, delay);
    }
    private observerDiscoveryFailed(): void {
        if (!this.observerPending) return;
        window.clearTimeout(this.observerTimer);
        this.observerTimer = undefined;
        this.observerPending = undefined;
        this.observerFailures = Math.min(this.observerFailures + 1, 3);
        if (!this.observerRoom()) return;
        this.observerUnknown = true;
        this.setState({...this.state, statusLabel: 'Group call status is unknown. Retrying automatically.'});
        this.scheduleObserverDiscovery(Math.min(30_000, 5_000 * 2 ** (this.observerFailures - 1)));
    }
    private handleObserverDiscovery(event: GroupCallDiscoveredSocketEvent): void {
        const pending = this.observerPending;
        const room = this.observerRoom();
        if (!pending || pending.requestID !== event.request_id || pending.generation !== this.generation || !room || room.conversation_id !== pending.conversationID || room.room_id !== pending.roomID || room.generation !== pending.roomGeneration || event.payload.conversation_id !== pending.conversationID) return;
        window.clearTimeout(this.observerTimer);
        this.observerTimer = undefined;
        this.observerPending = undefined;
        this.observerFailures = 0;
        const snapshot = event.payload.room;
        if (snapshot && snapshot.room_id === room.room_id && snapshot.generation === room.generation && snapshot.state_revision < this.lastAppliedStateRevision) {
            this.scheduleObserverDiscovery(10_000);
            return;
        }
        // A live event received after the request wins over a possibly older null
        // or different-room snapshot. The next poll can establish absence.
        if (this.lastAppliedStateRevision > pending.revision && (!snapshot || snapshot.room_id !== room.room_id || snapshot.generation !== room.generation || snapshot.status === 'ended')) {
            this.scheduleObserverDiscovery(10_000);
            return;
        }
        if (!snapshot || snapshot.room_id !== room.room_id || snapshot.generation !== room.generation || snapshot.status === 'ended') {
            this.terminal('The group call has ended.');
            return;
        }
        if (snapshot.state_revision >= this.lastAppliedStateRevision) {
            this.observerUnknown = false;
            this.lastAppliedStateRevision = snapshot.state_revision;
            this.applyRoom(snapshot, false);
        }
        this.scheduleObserverDiscovery(10_000);
    }
    private setState(state: GroupCallState): void {
        const previous = this.observerRoom();
        let statusLabel = state.statusLabel;
        if (state.phase === 'ringing' && !state.localStream && state.room && this.observerUnknown) statusLabel = 'Group call status is unknown. Retrying automatically.';
        if (state.phase === 'active' && state.localStream) {
            if (this.restartWarningActive && ![...this.connections.values()].some(peer => peer.restartUpdating)) this.restartWarningActive = false;
            if (this.failedPeers.size) statusLabel = iceFailure;
            else if (this.uncertainPeers.size) statusLabel = iceUncertainWarning;
            else if (this.credentialsFailed) statusLabel = credentialsWarning;
            else if (this.restartWarningActive) statusLabel = peerRestartWarning;
            else if ((statusLabel === credentialsWarning || statusLabel === peerRestartWarning || statusLabel === iceFailure || statusLabel === iceUncertainWarning) && state.room) statusLabel = this.participantStatus(state.room);
        }
        const errorLabel = this.failedPeers.size ? iceFailure : this.uncertainPeers.size ? iceUncertainWarning : state.errorLabel === iceFailure || state.errorLabel === iceUncertainWarning ? undefined : state.errorLabel;
        this.stateSubject.next(Object.freeze({...state, statusLabel, errorLabel, peers: [...state.peers]}));
        const next = this.observerRoom();
        const changed = !!previous && (!next || previous.room_id !== next.room_id || previous.generation !== next.generation || previous.conversation_id !== next.conversation_id);
        if (changed) this.stopObserverDiscovery();
        if (next && (!previous || changed)) this.scheduleObserverDiscovery(10_000);
    }

    private participantStatus(room: GroupCallRoomPayload): string {
        const count = room.participants.length;
        return `${count} participant${count === 1 ? '' : 's'} in the group call.`;
    }

    private scheduleInvitationDeadline(room: GroupCallRoomPayload, starter: boolean): void {
        window.clearTimeout(this.invitationTimer);
        this.invitationPeerJoined = starter && room.participants.some(participant => participant.user_id !== this.selfID);
        const deadline = Date.parse(room.ring_expires_at || '');
        if (!Number.isFinite(deadline)) return;
        const generation = this.generation;
        const update = (): void => {
            this.invitationTimer = undefined;
            if (!this.current(generation) || this.state.room?.room_id !== room.room_id || this.state.room.generation !== room.generation) return;
            const solo = starter && !this.invitationPeerJoined && !!this.state.localStream && this.state.room.participants.length === 1 && this.state.room.participants[0].user_id === this.selfID;
            this.setState({...this.state, invitationRinging: false, soloPrompt: solo, statusLabel: this.state.localStream ? this.credentialsFailed ? credentialsWarning : this.participantStatus(this.state.room) : 'Group call is ready to join.'});
        };
        if (deadline <= Date.now()) { update(); return; }
        this.setState({...this.state, invitationRinging: true, statusLabel: starter ? `${this.participantStatus(room)} Calling group members…` : 'Incoming group call.'});
        this.invitationTimer = window.setTimeout(update, deadline - Date.now());
    }

    private startSyncLoop(): void {
        if (this.syncTimer !== undefined || !this.dataProvider.ready || !['active', 'joining'].includes(this.state.phase) || !this.state.room || !this.state.localStream) return;
        const generation = this.generation;
        this.syncTimer = window.setInterval(() => {
            if (!this.current(generation) || !['active', 'joining'].includes(this.state.phase) || !this.dataProvider.ready) return;
            if (this.pendingSync) return;
            const room = this.state.room;
            if (!room || !isPositiveGeneration(room.generation)) return;
            const requestID = createRandomID();
            if (!this.current(generation)) return;
            if (!this.dataProvider.send({type: 'group.call.sync', request_id: requestID, payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation, ownership_status: true}})) {
                this.recordSyncVerificationFailure();
                return;
            }
            this.pendingSync = {requestID, generation, roomID: room.room_id, roomGeneration: room.generation};
            this.syncRequestTimeout = window.setTimeout(() => {
                if (this.pendingSync?.requestID !== requestID) return;
                this.pendingSync = undefined;
                this.syncRequestTimeout = undefined;
                this.recordSyncVerificationFailure();
            }, 8_000);
        }, 10_000);
    }

    private stopSyncLoop(): void {
        if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
        this.syncTimer = undefined;
        window.clearTimeout(this.syncRequestTimeout);
        this.syncRequestTimeout = undefined;
        this.pendingSync = undefined;
        this.syncVerificationFailures = 0;
    }
    private recordSyncVerificationFailure(): void {
        if (++this.syncVerificationFailures < 3) return;
        const room = this.state.room;
        const userID = this.selfID;
        if (!room || !userID || !this.state.localStream) return;
        const deviceID = this.selfDeviceID() || '';
        const revision = this.lastAppliedStateRevision;
        const label = 'Group call ownership could not be verified. Your microphone and screen share have been stopped.';
        this.fail(label, undefined, false);
        const control: PendingGroupCallControl = {requestID: createRandomID(), type: 'group.call.leave', room, baselineRevision: revision,
            localGeneration: this.generation, userID, deviceID, failureCleanup: true, originalFailureLabel: label};
        this.setControlReconciliationError(control);
    }
}

function controlRejectionLabel(type: GroupCallControlType): string {
    return type === 'group.call.leave' ? 'Could not leave the group call.' : 'Could not end the group call.';
}

function isEndedTrack(track: MediaStreamTrack): boolean { return track.readyState === 'ended'; }

function hasAudioOutputSink(audio: object): audio is AudioOutputSink {
    return 'setSinkId' in audio && typeof Reflect.get(audio, 'setSinkId') === 'function';
}

function isPositiveGeneration(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function createNegotiationID(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameParticipant(left: GroupCallParticipant | undefined, right: GroupCallParticipant | undefined): boolean {
    return left?.user_id === right?.user_id && left?.device_id === right?.device_id;
}

function comparePeerIdentity(leftUserID: string, leftDeviceID: string, rightUserID: string, rightDeviceID: string): number {
    if (leftUserID !== rightUserID) return leftUserID < rightUserID ? -1 : 1;
    if (leftDeviceID === rightDeviceID) return 0;
    return leftDeviceID < rightDeviceID ? -1 : 1;
}
