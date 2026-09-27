import {Injectable, OnDestroy} from '@angular/core';
import {BehaviorSubject, Subscription} from 'rxjs';
import {CallSignal, DataProviderService, GroupCallParticipant, GroupCallRoomEventPayload, GroupCallRoomPayload, GroupCallRoomSocketEvent, GroupCallSignalSocketEvent, GroupCallSyncedSocketEvent, ICEServer, isGroupRoomEventPayload, MessageSocketEvent} from './data-provider.service';
import {createRandomID} from '../login/login';

export type GroupCallPhase = 'idle' | 'requesting' | 'ringing' | 'joining' | 'active' | 'ended' | 'error';
export type GroupScreenQuality = '360p' | '720p' | '1080p' | '2k';
export interface GroupCallPeer { readonly userID: string; readonly deviceID: string; readonly stream?: MediaStream; readonly presentation?: MediaStream; }
export interface GroupCallState {
    readonly phase: GroupCallPhase;
    readonly room?: GroupCallRoomPayload;
    readonly localStream?: MediaStream;
    readonly peers: readonly GroupCallPeer[];
    readonly muted: boolean;
    readonly presentation?: MediaStream;
    readonly remotePresentation?: MediaStream;
    readonly sharing: boolean;
    readonly shareTransitioning: boolean;
    readonly inputDevices: readonly MediaDeviceInfo[];
    readonly outputDevices: readonly MediaDeviceInfo[];
    readonly selectedInputID?: string;
    readonly selectedOutputID?: string;
    readonly audioPlaybackBlocked: boolean;
    readonly statusLabel: string;
    readonly errorLabel?: string;
}

const idleState: GroupCallState = Object.freeze({phase: 'idle', peers: [], muted: false, sharing: false, shareTransitioning: false, inputDevices: [], outputDevices: [], audioPlaybackBlocked: false, statusLabel: 'No active group call.'});

interface PeerConnectionState {
    readonly connection: RTCPeerConnection;
    readonly generation: number;
    remoteDescriptionReady: boolean;
    readonly candidates: RTCIceCandidateInit[];
}

interface AudioOutputSink {
    setSinkId(deviceID: string): Promise<void>;
}

@Injectable()
export class GroupCallFacade implements OnDestroy {
    private readonly stateSubject = new BehaviorSubject<GroupCallState>(idleState);
    private readonly subscription: Subscription;
    private readonly connections = new Map<string, PeerConnectionState>();
    private readonly pendingSignals = new Map<string, CallSignal[]>();
    private readonly mediaSenders = new Map<string, RTCRtpSender>();
    private readonly presentationSenders = new Map<string, RTCRtpSender>();
    private readonly retiredRoomIDs = new Set<string>();
    private generation = 0;
    private selfID?: string;
    private conversationID?: string;
    private dismissTimer?: number;
    private syncTimer?: number;
    private syncRequestTimeout?: number;
    private pendingSync?: {requestID: string; generation: number; roomID: string; roomGeneration: number};
    private pendingStartOrJoin?: {requestID: string; generation: number};
    private lastAppliedStateRevision = -1;
    private deviceListener?: () => void;
    private readonly remoteAudios = new Set<HTMLAudioElement>();
    private readonly playbackRequestedAudios = new Set<HTMLAudioElement>();
    public readonly state$ = this.stateSubject.asObservable();

    public constructor(private readonly dataProvider: DataProviderService) {
        this.subscription = this.dataProvider.getObservable().subscribe(event => this.handleEvent(event));
        this.subscription.add(this.dataProvider.readyChanges.subscribe(ready => {
            if (!ready && this.isOngoing) this.fail('Realtime connection lost. Rejoin the group call after reconnecting.');
            else if (ready) this.startSyncLoop();
        }));
    }
    public get state(): GroupCallState { return this.stateSubject.value; }
    public get isOngoing(): boolean { return ['ringing', 'joining', 'active'].includes(this.state.phase); }

    public async start(conversationID: string, selfID: string): Promise<void> {
        if (!this.canStart()) return;
        const generation = this.beginGeneration(selfID, conversationID);
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

    public async join(room: GroupCallRoomPayload, selfID: string): Promise<void> {
        if (!this.canStart() || room.status === 'ended' || !isPositiveGeneration(room.generation)) return;
        const generation = this.beginGeneration(selfID, room.conversation_id);
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

    public leave(): void { this.control('group.call.leave', 'You left the group call.'); }
    public end(): void { this.control('group.call.end', 'Group call ended.'); }
    /** Stops local group-call work for a removed conversation without signaling other members. */
    public abort(conversationID: string): boolean {
        if (this.conversationID !== conversationID && this.state.room?.conversation_id !== conversationID) return false;
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
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: {deviceId: {exact: deviceID}}});
            if (!this.current(generation)) { this.stop(stream); return; }
            const track = stream.getAudioTracks()[0];
            if (!track) { this.stop(stream); return; }
            await Promise.all([...this.mediaSenders.values()].map(sender => this.replaceTrack(sender, track)));
            this.stop(this.state.localStream);
            this.setState({...this.state, localStream: stream, selectedInputID: deviceID, statusLabel: 'Microphone changed.'});
        } catch { this.fail('The selected microphone is unavailable.'); }
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
    public async startPresentation(quality: GroupScreenQuality): Promise<void> {
        const room = this.state.room;
        const generation = this.generation;
        if (!room || !isPositiveGeneration(room.generation) || !this.state.localStream || this.state.shareTransitioning || !this.current(generation)) return;
        this.setState({...this.state, shareTransitioning: true, statusLabel: 'Starting presentation...'});
        try {
            if (!this.send({type: 'group.call.presenter.start', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, generation)) return;
            const stream = await navigator.mediaDevices.getDisplayMedia({video: this.screenConstraints(quality), audio: false});
            if (!this.current(generation)) { this.stop(stream); return; }
            const track = stream.getVideoTracks()[0];
            if (!track) { this.stop(stream); this.stopPresentation(); return; }
            track.addEventListener('ended', () => { if (this.current(generation)) this.stopPresentation(); }, {once: true});
            for (const [key, state] of this.connections) {
                const sender = this.presentationSenders.get(key) || state.connection.addTrack(track, stream);
                this.presentationSenders.set(key, sender);
                await sender.replaceTrack(track);
                await this.offerParticipant(key, state, generation);
            }
            this.setState({...this.state, presentation: stream, sharing: true, shareTransitioning: false, statusLabel: 'You are presenting.'});
        } catch {
            if (this.current(generation)) {
                this.send({type: 'group.call.presenter.stop', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, generation);
                this.setState({...this.state, shareTransitioning: false, statusLabel: 'Presentation was not started.'});
            }
        }
    }
    public stopPresentation(): void {
        const room = this.state.room;
        const generation = this.generation;
        if (!room || !isPositiveGeneration(room.generation) || !this.state.presentation || !this.current(generation)) return;
        this.clearPresentation(false);
        this.send({type: 'group.call.presenter.stop', request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, generation);
        this.setState({...this.state, statusLabel: 'Presentation stopped.'});
    }
    public close(): void { this.terminal('Group call ended.', false); this.subscription.unsubscribe(); }
    public ngOnDestroy(): void { this.close(); }

    private handleEvent(event: MessageSocketEvent): void {
        if (event.type === 'call.rejected') {
            const pending = this.pendingStartOrJoin;
            if (!pending || event.request_id !== pending.requestID || !this.current(pending.generation)) return;
            this.pendingStartOrJoin = undefined;
            const label = `Group call unavailable: ${event.payload.error}`;
            this.fail(label);
            return;
        }
        if (event.type === 'group.call.signal') {
            void this.signal(event);
            return;
        }
        if (event.type === 'group.call.synced') {
            this.handleSynced(event);
            return;
        }
        if (!this.isRoomEvent(event)) return;
        if (event.type === 'group.call.ended' && !isGroupRoomEventPayload(event.payload)) {
            const room = this.state.room;
            const terminal = event.payload;
            if (!room || room.room_id !== terminal.room_id || room.generation !== terminal.generation || terminal.state_revision <= this.lastAppliedStateRevision) return;
            this.lastAppliedStateRevision = terminal.state_revision;
            this.terminal('Group call ended.');
            return;
        }
        if (!isGroupRoomEventPayload(event.payload)) return;
        const room = event.payload;
        if (!this.acceptsRoomEvent(event, room)) return;
        if (event.type === 'group.call.started') this.pendingStartOrJoin = undefined;
        this.lastAppliedStateRevision = room.state_revision;
        if (room.status === 'ended') {
            this.terminal('Group call ended.');
            return;
        }
        if (event.type === 'group.call.started' && this.state.phase === 'idle') {
            this.setState({...idleState, phase: 'ringing', room, statusLabel: 'Group call is starting.'});
            return;
        }
        const previousPresenter = this.state.room?.presenter;
        if (event.type === 'group.call.participant.left' && previousPresenter && !room.participants.some(participant => participant.user_id === previousPresenter.user_id && participant.device_id === previousPresenter.device_id)) {
            this.clearRemotePresentation();
        }
        if (event.type === 'group.call.presenter.start' && this.state.presentation && (room.presenter?.user_id !== this.selfID || room.presenter?.device_id !== this.selfDeviceID())) this.clearPresentation(false);
        if (event.type === 'group.call.presenter.stop') this.setState({...this.state, remotePresentation: undefined, peers: this.state.peers.map(peer => ({...peer, presentation: undefined}))});
        this.applyRoom(room, event.type === 'group.call.started' || event.type === 'group.call.participant.joined');
    }

    private handleSynced(event: GroupCallSyncedSocketEvent): void {
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
        if (this.state.phase === 'idle') return event.type === 'group.call.started' && !this.retiredRoomIDs.has(room.room_id) && room.state_revision > this.lastAppliedStateRevision;
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
            if (!expected.has(key)) { connection.connection.close(); this.connections.delete(key); this.mediaSenders.delete(key); this.presentationSenders.delete(key); }
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
                    // Non-presenting peers can still have negotiated empty video
                    // receivers. Keep per-peer ownership, and promote a stream only
                    // after its receiver has actually started delivering frames.
                    const updatePresentation = (): void => {
                        if (!this.current(generation) || this.connections.get(key) !== state || event.track.muted) return;
                        this.setState({...this.state, remotePresentation: remote, peers: this.state.peers.map(peer => peer.userID === participant.user_id && peer.deviceID === participant.device_id ? {...peer, presentation: remote} : peer)});
                    };
                    event.track.addEventListener('unmute', updatePresentation);
                    updatePresentation();
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
        this.mediaSenders.delete(key); this.presentationSenders.delete(key);
        this.setState({...this.state, peers: this.state.peers.filter(peer => this.key(peer.userID, peer.deviceID) !== key)});
    }
    private control(type: 'group.call.leave' | 'group.call.end', label: string): void {
        const room = this.state.room;
        if (room && (!isPositiveGeneration(room.generation) || !this.send({type, request_id: createRandomID(), payload: {conversation_id: room.conversation_id, room_id: room.room_id, generation: room.generation}}, this.generation))) return;
        this.terminal(label);
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
    private terminal(label: string, dismiss = true): void {
        this.pendingStartOrJoin = undefined;
        this.stopSyncLoop();
        this.retireRoom(this.state.room?.room_id);
        this.generation += 1;
        for (const state of this.connections.values()) state.connection.close();
        this.connections.clear(); this.pendingSignals.clear(); this.mediaSenders.clear(); this.presentationSenders.clear(); this.stop(this.state.localStream); this.stop(this.state.presentation);
        if (this.deviceListener) navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceListener);
        this.deviceListener = undefined;
        for (const audio of this.remoteAudios) { audio.pause(); audio.srcObject = null; }
        this.remoteAudios.clear();
        this.playbackRequestedAudios.clear();
        this.conversationID = undefined;
        this.selfID = undefined;
        this.setState({...idleState, phase: 'ended', statusLabel: label});
        if (dismiss) { window.clearTimeout(this.dismissTimer); this.dismissTimer = window.setTimeout(() => this.setState(idleState), 5_000); }
    }
    private fail(label: string): void { this.terminal(label, false); this.setState({...idleState, phase: 'error', statusLabel: label, errorLabel: label}); }
    private beginGeneration(selfID: string, conversationID: string): number { window.clearTimeout(this.dismissTimer); this.stopSyncLoop(); this.lastAppliedStateRevision = -1; this.generation += 1; this.selfID = selfID; this.conversationID = conversationID; return this.generation; }
    private current(generation: number): boolean { return generation === this.generation; }
    private canStart(): boolean { return ['idle', 'ended', 'error', 'ringing'].includes(this.state.phase); }
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
    private async replaceTrack(sender: RTCRtpSender, track: MediaStreamTrack | null): Promise<void> {
        // Chromium can leave replaceTrack pending while a peer is still negotiating.
        // Do not trap the device-control UI behind that browser callback.
        await Promise.race([sender.replaceTrack(track), new Promise<void>(resolve => window.setTimeout(resolve, 1_500))]);
    }
    private clearPresentation(transitioning: boolean): void {
        this.stop(this.state.presentation);
        for (const sender of this.presentationSenders.values()) void sender.replaceTrack(null);
        this.setState({...this.state, presentation: undefined, sharing: false, shareTransitioning: transitioning});
    }
    private clearRemotePresentation(): void {
        this.setState({...this.state, remotePresentation: undefined, peers: this.state.peers.map(peer => ({...peer, presentation: undefined}))});
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
