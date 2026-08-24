import {Injectable, OnDestroy} from '@angular/core';
import {BehaviorSubject, Subscription} from 'rxjs';
import {CallAcceptedSocketEvent, CallPayload, CallSignal, CallSignalSocketEvent, CallSocketEvent, ClientSocketEvent, DataProviderService, ICEServer} from './data-provider.service';
import {createRandomID} from '../login/login';

export type CallPhase = 'idle' | 'requesting' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended' | 'error';
export type CallRole = 'caller' | 'recipient';
export type ScreenShareQuality = '360p' | '720p' | '1080p' | '2k';
export interface CallDevice { readonly deviceID: string; readonly label: string; }
export interface CallState {
    readonly phase: CallPhase;
    readonly role?: CallRole;
    readonly callID?: string;
    readonly conversationID?: string;
    readonly peerID?: string;
    readonly muted: boolean;
    readonly localStream?: MediaStream;
    readonly remoteStream?: MediaStream;
    readonly screenShareStream?: MediaStream;
    readonly remoteScreenStream?: MediaStream;
    readonly screenShareQuality: ScreenShareQuality;
    readonly screenShareAudioEnabled: boolean;
    readonly screenShareAudioActive: boolean;
    readonly screenShareTransition: boolean;
    readonly audioPlaybackBlocked?: boolean;
    readonly inputDevices?: readonly CallDevice[];
    readonly outputDevices?: readonly CallDevice[];
    readonly selectedInputDeviceID?: string;
    readonly selectedOutputDeviceID?: string;
    readonly outputSelectionSupported?: boolean;
    readonly statusLabel: string;
    readonly errorLabel?: string;
}
type DisplayMediaOptions = DisplayMediaStreamOptions & {
    readonly selfBrowserSurface?: 'include' | 'exclude';
    readonly surfaceSwitching?: 'include' | 'exclude';
    readonly monitorTypeSurfaces?: 'include' | 'exclude';
    readonly systemAudio?: 'include' | 'exclude';
    readonly windowAudio?: 'exclude' | 'window' | 'system';
};
const idleState: CallState = Object.freeze({phase: 'idle', muted: false, screenShareQuality: '720p', screenShareAudioEnabled: false, screenShareAudioActive: false, screenShareTransition: false, statusLabel: 'No active call.'});
const callNoticeDuration = 5_000;
const screenShareDimensions: Record<ScreenShareQuality, {width: number; height: number}> = {
    '360p': {width: 640, height: 360},
    '720p': {width: 1280, height: 720},
    '1080p': {width: 1920, height: 1080},
    '2k': {width: 2560, height: 1440},
};

@Injectable()
export class CallFacade implements OnDestroy {
    private readonly stateSubject = new BehaviorSubject<CallState>(idleState);
    private readonly subscription: Subscription;
    private connection?: RTCPeerConnection;
    private screenSender?: RTCRtpSender;
    private screenAudioSender?: RTCRtpSender;
    private pendingSignals: CallSignal[] = [];
    private remoteScreenStream?: MediaStream;
    private remoteScreenSharing = false;
    private signalingChain: Promise<void> = Promise.resolve();
    private readonly pendingRequestGenerations = new Map<string, {generation: number; type: string; createdAt: number}>();
    private readonly retiredCallIDs = new Set<string>();
    private readonly orphanedStartConversations = new Set<string>();
    private pendingCandidates: RTCIceCandidateInit[] = [];
    private remoteDescriptionReady = false;
    private callGeneration = 0;
    private localRenegotiationPending = false;
    private remoteAudio?: HTMLAudioElement;
    private dismissTimer?: number;
    private readonly deviceChangeListener = (): void => { void this.refreshDevices(); };
    public readonly state$ = this.stateSubject.asObservable();

    public constructor(private readonly dataProvider: DataProviderService) {
        this.subscription = new Subscription();
        this.subscription.add(this.dataProvider.getObservable().subscribe(event => { if (event.type.startsWith('call.')) this.handleEvent(event as CallSocketEvent); }));
        this.subscription.add(this.dataProvider.readyChanges.subscribe(ready => {
            if (!ready && ['requesting', 'outgoing', 'incoming', 'connecting', 'active'].includes(this.state.phase)) {
                if (!this.state.callID && this.state.conversationID) {
                    while (this.orphanedStartConversations.size >= 32) {
                        const oldest = this.orphanedStartConversations.values().next();
                        if (oldest.done || oldest.value === undefined) break;
                        this.orphanedStartConversations.delete(oldest.value);
                    }
                    this.orphanedStartConversations.add(this.state.conversationID);
                }
                this.setError('Realtime connection lost. Reconnecting...', this.callGeneration);
            }
        }));
        navigator.mediaDevices?.addEventListener?.('devicechange', this.deviceChangeListener);
    }
    public get state(): CallState { return this.stateSubject.value; }
    public get inputDevices(): readonly CallDevice[] { return this.state.inputDevices || []; }
    public get outputDevices(): readonly CallDevice[] { return this.state.outputDevices || []; }
    public get selectedInputDeviceID(): string { return this.state.selectedInputDeviceID || ''; }
    public get selectedOutputDeviceID(): string { return this.state.selectedOutputDeviceID || ''; }
    public get outputSelectionSupported(): boolean { return this.state.outputSelectionSupported === true; }

    public get screenShareQuality(): ScreenShareQuality { return this.state.screenShareQuality; }
    public screenShareSupported(): boolean { return typeof navigator.mediaDevices?.getDisplayMedia === 'function'; }
    public setScreenShareAudioEnabled(enabled: boolean): void {
        if (this.state.screenShareStream || this.state.screenShareTransition) return;
        this.setState({...this.state, screenShareAudioEnabled: enabled, screenShareAudioActive: false});
    }

    public async start(conversationID: string, peerID: string): Promise<void> {
        if (!this.canStart()) return;
        const generation = this.beginCallGeneration();
        this.clearDismissTimer();
        this.setState({...this.state, phase: 'requesting', role: 'caller', conversationID, peerID, muted: false, statusLabel: 'Requesting microphone access...'});
        const stream = await this.requestMicrophone(undefined, true, generation);
        if (!stream) return;
        if (!this.isCurrentGeneration(generation) || this.state.phase !== 'requesting') { this.stopStream(stream); return; }
        if (!this.sendRequest({type: 'call.start', request_id: createRandomID(), payload: {conversation_id: conversationID}}, generation)) { this.stopStream(stream); return; }
        this.setState({...this.state, phase: 'outgoing', role: 'caller', conversationID, peerID, muted: false, localStream: stream, statusLabel: 'Calling...'});
    }
    public accept(): void {
        const state = this.state;
        if (state.phase !== 'incoming' || !state.callID) return;
        const generation = this.callGeneration;
        if (!this.sendRequest({type: 'call.accept', request_id: createRandomID(), payload: {call_id: state.callID}}, generation)) return;
        this.setState({...state, phase: 'connecting', statusLabel: 'Connecting call...'});
    }
    public decline(): void { this.sendControl('call.decline', 'Call declined.'); }
    public cancel(): void { this.sendControl('call.cancel', 'Call cancelled.'); }
    public end(): void { this.sendControl('call.end', 'Call ended.'); }
    public toggleMute(): void {
        const state = this.state;
        if (!state.localStream) return;
        const muted = !state.muted;
        state.localStream.getAudioTracks().forEach(track => track.enabled = !muted);
        this.setState({...state, muted, statusLabel: muted ? 'Microphone muted.' : 'Microphone on.'});
    }
    public async toggleScreenShare(): Promise<void> {
        if (this.state.screenShareTransition) return;
        const generation = this.callGeneration;
        this.setState({...this.state, screenShareTransition: true});
        await this.enqueueSignaling(async () => {
            if (!this.isCurrentGeneration(generation)) return;
            if (this.state.screenShareStream) await this.stopScreenShare(undefined, generation);
            else await this.startScreenShare(generation);
        }).catch(() => {
            if (this.isCurrentGeneration(generation)) this.setError('Could not update screen sharing.', generation);
        });
        if (this.isCurrentGeneration(generation)) this.setState({...this.state, screenShareTransition: false});
    }
    public async selectScreenShareQuality(quality: ScreenShareQuality): Promise<void> {
        if (!screenShareDimensions[quality]) return;
        const generation = this.callGeneration;
        const track = this.state.screenShareStream?.getVideoTracks()[0];
        this.setState({...this.state, screenShareQuality: quality});
        if (!track || typeof track.applyConstraints !== 'function') return;
        try {
            await track.applyConstraints(this.screenShareConstraints(quality));
            if (!this.isCurrentGeneration(generation)) return;
        } catch {
            if (this.isCurrentGeneration(generation)) this.setState({...this.state, statusLabel: 'Screen quality could not be changed.'});
        }
    }
    private async startScreenShare(generation: number): Promise<void> {
        const connection = this.connection;
        const callID = this.state.callID;
        if (this.state.phase !== 'active' || !connection || !callID || !this.screenShareSupported()) return;
        let stream: MediaStream;
        try {
            const displayOptions: DisplayMediaOptions = {
                video: this.screenShareConstraints(this.state.screenShareQuality),
                audio: this.state.screenShareAudioEnabled,
                selfBrowserSurface: 'include',
                surfaceSwitching: 'include',
                monitorTypeSurfaces: 'include',
                systemAudio: 'include',
                windowAudio: 'system',
            };
            stream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
        } catch (error: unknown) {
            const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
            if (name !== 'AbortError' && name !== 'NotAllowedError' && this.isCurrentGeneration(generation)) this.setState({...this.state, statusLabel: 'Screen sharing is unavailable.', errorLabel: 'Screen sharing is unavailable.'});
            return;
        }
        if (!this.isCurrentGeneration(generation) || this.connection !== connection || this.state.phase !== 'active') {
            this.stopStream(stream);
            return;
        }
        const track = stream.getVideoTracks()[0];
        if (!track) {
            this.stopStream(stream);
            this.setState({...this.state, statusLabel: 'No screen was selected.'});
            return;
        }
        const sender = this.screenSender || connection.getSenders().find(item => item.track?.kind === 'video');
        const audioTrack = stream.getAudioTracks()[0];
        try {
            if (sender) await sender.replaceTrack(track);
            else this.screenSender = connection.addTrack(track, stream);
            if (audioTrack) {
                if (this.screenAudioSender) await this.screenAudioSender.replaceTrack(audioTrack);
                else this.screenAudioSender = connection.addTrack(audioTrack, stream);
            }
            if (!this.isCurrentGeneration(generation) || this.connection !== connection) {
                this.stopStream(stream);
                return;
            }
            this.screenSender = sender || this.screenSender;
            track.onended = () => {
                void this.enqueueSignaling(() => this.stopScreenShare(track, generation, connection, callID)).catch(() => {
                    if (this.isCurrentGeneration(generation)) this.setError('Screen sharing could not stop.', generation);
                });
            };
            if (audioTrack) {
                audioTrack.onended = () => {
                    void this.enqueueSignaling(() => this.stopScreenShareAudio(audioTrack, generation, connection, callID)).catch(() => {
                        if (this.isCurrentGeneration(generation)) this.setError('Screen-share audio could not stop.', generation);
                    });
                };
            }
            const statusLabel = this.state.screenShareAudioEnabled && !audioTrack ? 'You are sharing your screen. System audio was not available.' : 'You are sharing your screen.';
            this.setState({...this.state, screenShareStream: stream, screenShareAudioActive: Boolean(audioTrack), statusLabel, errorLabel: undefined});
            this.sendSignal({type: 'screen-share-started'}, generation, callID);
            await this.createAndSendOffer(generation, connection, callID);
        } catch {
            this.stopStream(stream);
            if (this.isCurrentGeneration(generation)) this.setState({...this.state, statusLabel: 'Screen sharing could not start.', errorLabel: 'Screen sharing could not start.'});
        }
    }
    private async stopScreenShare(track?: MediaStreamTrack, generation = this.callGeneration, connection = this.connection, callID = this.state.callID): Promise<void> {
        if (!this.isCurrentGeneration(generation) || !connection || !callID || this.connection !== connection) return;
        const stream = this.state.screenShareStream;
        if (!stream || (track && !stream.getVideoTracks().includes(track))) return;
        const sender = this.screenSender || connection.getSenders().find(item => item.track?.kind === 'video');
        const audioSender = this.screenAudioSender;
        this.setState({...this.state, screenShareStream: undefined, screenShareAudioActive: false, statusLabel: 'Screen sharing stopped.'});
        stream.getTracks().forEach(mediaTrack => mediaTrack.onended = null);
        this.stopStream(stream);
        try {
            if (sender) await sender.replaceTrack(null);
            if (audioSender) await audioSender.replaceTrack(null);
            if (!this.isCurrentGeneration(generation) || this.connection !== connection) return;
            this.sendSignal({type: 'screen-share-stopped'}, generation, callID);
            await this.createAndSendOffer(generation, connection, callID);
        } catch {
            if (this.isCurrentGeneration(generation)) this.setState({...this.state, statusLabel: 'Screen sharing could not stop.'});
        }
    }
    private async stopScreenShareAudio(track: MediaStreamTrack, generation: number, connection: RTCPeerConnection, callID: string): Promise<void> {
        if (!this.isCurrentGeneration(generation) || this.connection !== connection || this.state.screenShareStream?.getAudioTracks().includes(track) !== true) return;
        track.onended = null;
        try {
            await this.screenAudioSender?.replaceTrack(null);
            if (!this.isCurrentGeneration(generation) || this.connection !== connection) return;
            this.setState({...this.state, screenShareAudioActive: false, statusLabel: 'Screen sharing continues without system audio.'});
            await this.createAndSendOffer(generation, connection, callID);
        } catch {
            if (this.isCurrentGeneration(generation)) this.setState({...this.state, screenShareAudioActive: false, statusLabel: 'System audio could not stop.'});
        }
    }
    private screenShareConstraints(quality: ScreenShareQuality): MediaTrackConstraints {
        const dimensions = screenShareDimensions[quality];
        return {width: {ideal: dimensions.width}, height: {ideal: dimensions.height}, frameRate: {ideal: 30, max: 30}};
    }
    public playRemoteAudio(event: Event): void {
        const audio = event.currentTarget as HTMLAudioElement | null;
        if (!audio) return;
        this.remoteAudio = audio;
        void this.tryPlayRemoteAudio(audio, this.callGeneration);
    }
    public enableRemoteAudio(): void {
        if (this.remoteAudio) void this.tryPlayRemoteAudio(this.remoteAudio, this.callGeneration);
    }

    public playRemoteScreen(event: Event): void {
        const video = event.currentTarget as HTMLVideoElement | null;
        if (!video) return;
        video.autoplay = true;
        video.muted = true;
        if (this.state.remoteScreenStream && video.srcObject !== this.state.remoteScreenStream) video.srcObject = this.state.remoteScreenStream;
        void video.play().catch(() => undefined);
    }

    public async selectInputDevice(deviceID: string): Promise<void> {
        if (!deviceID || !this.state.localStream || deviceID === this.selectedInputDeviceID) return;
        if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function') return;
        const generation = this.callGeneration;
        const currentStream = this.state.localStream;
        const connection = this.connection;
        let replacement: MediaStream;
        try {
            replacement = await navigator.mediaDevices.getUserMedia({audio: {deviceId: {exact: deviceID}}});
        } catch (error: unknown) {
            const label = this.microphoneErrorLabel(error);
            if (this.isCurrentGeneration(generation)) this.setState({...this.state, statusLabel: label, errorLabel: label});
            return;
        }
        if (!this.isCurrentGeneration(generation) || this.connection !== connection) {
            this.stopStream(replacement);
            return;
        }
        const track = replacement.getAudioTracks()[0];
        if (!track) {
            this.stopStream(replacement);
            return;
        }
        try {
            const sender = connection?.getSenders().find(item => item.track?.kind === 'audio');
            if (!sender) throw new Error('audio sender unavailable');
            await sender.replaceTrack(track);
            if (!this.isCurrentGeneration(generation) || this.connection !== connection) {
                this.stopStream(replacement);
                return;
            }
            this.stopStream(currentStream);
            this.setState({...this.state, localStream: replacement, selectedInputDeviceID: deviceID, errorLabel: undefined, statusLabel: 'Microphone changed.'});
            await this.refreshDevices(generation);
        } catch {
            this.stopStream(replacement);
            if (this.isCurrentGeneration(generation)) this.setState({...this.state, statusLabel: 'Could not change the microphone.', errorLabel: 'Could not change the microphone.'});
        }
    }

    public async selectOutputDevice(deviceID: string): Promise<void> {
        if (!deviceID) return;
        const generation = this.callGeneration;
        const audio = this.remoteAudio;
        this.setState({...this.state, selectedOutputDeviceID: deviceID});
        if (!audio) return;
        if (!(await this.applyOutputDevice(audio, deviceID, generation)) || !this.isCurrentGeneration(generation)) return;
        this.setState({...this.state, selectedOutputDeviceID: deviceID, outputSelectionSupported: true, errorLabel: undefined, statusLabel: 'Speaker changed.'});
    }
    public close(): void {
        this.clearDismissTimer();
        const state = this.state;
        if (state.callID) {
            const type = state.phase === 'incoming' ? 'call.decline' : state.phase === 'outgoing' ? 'call.cancel' : 'call.end';
            this.dataProvider.send({type, request_id: createRandomID(), payload: {call_id: state.callID}});
        }
        this.invalidateCallGeneration();
        this.cleanup(); this.subscription.unsubscribe(); this.setState(idleState);
        navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceChangeListener);
    }
    public ngOnDestroy(): void { this.close(); }

    private handleEvent(event: CallSocketEvent): void {
        if (event.type === 'call.rejected') {
            this.prunePendingRequests();
            const request = event.request_id ? this.pendingRequestGenerations.get(event.request_id) : undefined;
            if (event.request_id) this.pendingRequestGenerations.delete(event.request_id);
            if (request && this.isCurrentGeneration(request.generation)) this.setError(this.rejectionLabel(event.payload.error), request.generation);
            return;
        }
        if (event.type === 'call.incoming') {
            if (!this.isRetiredCall(event.payload.call_id)) this.handleIncoming(event.payload);
            return;
        }
        if (event.type === 'call.accepted') {
            if (this.state.callID !== event.payload.call_id || this.isRetiredCall(event.payload.call_id)) return;
            this.enqueueSignaling(() => this.handleAccepted(event)).catch(() => {
                if (this.matches(event.payload.call_id)) this.setError('Could not connect the audio call.', this.callGeneration);
            });
            return;
        }
        if (event.type === 'call.signal') {
            if (this.isRetiredCall(event.payload.call_id)) return;
            if (event.payload.signal.type === 'screen-share-started' || event.payload.signal.type === 'screen-share-stopped') {
                this.handleScreenLifecycleSignal(event);
                return;
            }
            this.enqueueSignaling(() => this.handleSignal(event)).catch(() => {
                if (this.matches(event.payload.call_id)) this.setError('Could not process call signaling.', this.callGeneration);
            });
            return;
        }
        if (event.type === 'call.ringing' && this.state.callID === undefined && this.state.role === 'caller' && this.state.phase === 'outgoing' && this.state.conversationID === event.payload.conversation_id && !this.isRetiredCall(event.payload.call_id)) {
            this.orphanedStartConversations.delete(event.payload.conversation_id);
            this.clearPendingRequests(this.callGeneration, 'call.start');
            this.setState({...this.state, callID: event.payload.call_id, statusLabel: 'Ringing...'});
            return;
        }
        if (event.type === 'call.ringing' && this.orphanedStartConversations.delete(event.payload.conversation_id)) {
            this.dataProvider.send({type: 'call.cancel', request_id: createRandomID(), payload: {call_id: event.payload.call_id}});
            return;
        }
        if (this.isRetiredCall(event.payload.call_id)) return;
        if (!this.matches(event.payload.call_id)) return;
        if (event.type === 'call.declined') this.terminal('Call declined.', this.callGeneration);
        if (event.type === 'call.ended') this.terminal(this.state.phase === 'outgoing' ? 'No answer.' : 'Call ended.', this.callGeneration);
    }
    private handleIncoming(payload: CallPayload): void {
        if (!this.canStart()) { this.dataProvider.send({type: 'call.decline', request_id: createRandomID(), payload: {call_id: payload.call_id}}); return; }
        this.clearDismissTimer();
        this.setState({...this.state, phase: 'incoming', role: 'recipient', callID: payload.call_id, conversationID: payload.conversation_id, peerID: payload.caller_id, muted: false, statusLabel: 'Incoming audio call.'});
    }
    private async handleAccepted(event: CallAcceptedSocketEvent): Promise<void> {
        const generation = this.callGeneration;
        const state = this.state;
        if (state.callID !== event.payload.call_id || (state.role === 'recipient' && state.phase !== 'connecting')) return;
        this.clearPendingRequests(generation, 'call.accept');
        let localStream = state.localStream;
        if (state.role === 'recipient') {
            localStream = await this.requestMicrophone(undefined, true, generation);
            if (!localStream) {
                return;
            }
        }
        if (!this.isCurrentGeneration(generation) || this.state.callID !== event.payload.call_id || !localStream || !this.createConnection(event.payload.ice_servers, localStream, generation, event.payload.call_id)) {
            if (localStream && localStream !== state.localStream) this.stopStream(localStream);
            return;
        }
        this.setState({...this.state, phase: 'connecting', callID: event.payload.call_id, conversationID: event.payload.conversation_id, peerID: this.peerFor(event.payload), localStream, statusLabel: 'Connecting call...'});
        for (const signal of this.pendingSignals.splice(0)) await this.applySignal(signal);
        if (this.state.role === 'caller') await this.createAndSendOffer(generation, this.connection, event.payload.call_id);
    }
    private async handleSignal(event: CallSignalSocketEvent): Promise<void> {
        if (!this.matches(event.payload.call_id)) return;
        if (!this.connection) { this.pendingSignals.push(event.payload.signal); return; }
        await this.applySignal(event.payload.signal);
    }

    private handleScreenLifecycleSignal(event: CallSignalSocketEvent): void {
        if (!this.matches(event.payload.call_id)) return;
        if (event.payload.signal.type === 'screen-share-stopped') {
            this.remoteScreenSharing = false;
            this.clearRemoteScreen();
            return;
        }
        if (event.payload.signal.type === 'screen-share-started') {
            this.remoteScreenSharing = true;
            this.restoreRemoteScreen();
        }
    }

    private clearRemoteScreen(): void {
        this.setState({...this.state, remoteScreenStream: undefined});
    }
    private restoreRemoteScreen(): void {
        if (this.remoteScreenSharing && this.remoteScreenStream) this.setState({...this.state, remoteScreenStream: this.remoteScreenStream});
    }
    private async applySignal(signal: CallSignal): Promise<void> {
        const connection = this.connection;
        const generation = this.callGeneration;
        const callID = this.state.callID;
        if (!connection || !callID) return;
        if (signal.type === 'candidate') {
            if (!this.remoteDescriptionReady) {
                this.pendingCandidates.push(signal.candidate as RTCIceCandidateInit);
                return;
            }
            try {
                await connection.addIceCandidate(signal.candidate as RTCIceCandidateInit);
            } catch {
                if (this.isCurrentGeneration(generation)) this.setError('Could not connect the audio call.', generation);
            }
            return;
        }
        try {
            if (signal.type === 'offer') {
                const offerCollision = connection.signalingState !== 'stable';
                if (offerCollision && !this.isPolite()) return;
                if (offerCollision) {
                    this.localRenegotiationPending = true;
                    await connection.setLocalDescription({type: 'rollback'});
                }
                await connection.setRemoteDescription({type: 'offer', sdp: signal.sdp});
                this.remoteDescriptionReady = true;
                await this.flushPendingCandidates(connection, generation);
                const answer = await connection.createAnswer();
                if (answer.type !== 'answer' || typeof answer.sdp !== 'string') throw new Error('answer unavailable');
                await connection.setLocalDescription(answer);
                this.sendSignal({type: 'answer', sdp: answer.sdp}, generation, callID);
                this.restoreRemoteScreen();
                if (this.localRenegotiationPending) {
                    this.localRenegotiationPending = false;
                    await this.createAndSendOffer(generation, connection, callID);
                }
            }
            else if (signal.type === 'answer') {
                if (connection.signalingState !== 'have-local-offer') return;
                await connection.setRemoteDescription({type: 'answer', sdp: signal.sdp});
                this.remoteDescriptionReady = true;
                await this.flushPendingCandidates(connection, generation);
                if (this.localRenegotiationPending) {
                    this.localRenegotiationPending = false;
                    await this.createAndSendOffer(generation, connection, callID);
                }
            }
        } catch {
            if (this.isCurrentGeneration(generation)) this.setError('Could not connect the audio call.', generation);
        }
    }
    private async flushPendingCandidates(connection: RTCPeerConnection, generation: number): Promise<void> {
        const candidates = this.pendingCandidates.splice(0);
        for (const candidate of candidates) {
            if (!this.isCurrentGeneration(generation) || this.connection !== connection) return;
            await connection.addIceCandidate(candidate);
        }
    }
    private createConnection(iceServers: ICEServer[], localStream: MediaStream, generation: number, callID: string): boolean {
        try {
            const connection = new RTCPeerConnection({iceServers});
            this.connection = connection;
            this.remoteDescriptionReady = false;
            this.pendingCandidates = [];
            localStream.getTracks().forEach(track => connection.addTrack(track, localStream));
            connection.onicecandidate = event => { if (event.candidate && this.isCurrentGeneration(generation) && this.connection === connection) this.sendSignal({type: 'candidate', candidate: event.candidate.toJSON()}, generation, callID); };
            connection.ontrack = event => {
                if (!this.isCurrentGeneration(generation) || this.connection !== connection || this.state.callID !== callID) return;
                const remoteStream = event.streams[0] || new MediaStream([event.track]);
                if (event.track?.kind === 'video') {
                    this.remoteScreenStream = remoteStream;
                    this.remoteScreenSharing = true;
                    event.track.onended = () => {
                        if (this.remoteScreenStream === remoteStream) {
                            this.remoteScreenStream = undefined;
                            this.remoteScreenSharing = false;
                            this.clearRemoteScreen();
                        }
                    };
                    this.setState({...this.state, remoteScreenStream: remoteStream});
                    return;
                }
                const combinedAudioStream = this.mergeRemoteAudioStream(remoteStream, event.track);
                this.setState({...this.state, remoteStream: combinedAudioStream, audioPlaybackBlocked: false, phase: 'active', statusLabel: 'Audio call connected.'});
                if (this.remoteAudio) {
                    this.remoteAudio.srcObject = combinedAudioStream;
                    void this.tryPlayRemoteAudio(this.remoteAudio, generation);
                }
            };
            connection.onconnectionstatechange = () => {
                if (this.isCurrentGeneration(generation) && this.connection === connection && connection.connectionState === 'failed') this.setError('Could not connect the audio call.', generation);
            };
            return true;
        } catch { this.setError('Audio calls are not supported by this browser.'); return false; }
    }
    private mergeRemoteAudioStream(incoming: MediaStream, track: MediaStreamTrack): MediaStream {
        const current = this.state.remoteStream;
        if (!current || current === incoming || typeof current.addTrack !== 'function') return incoming;
        if (!current.getAudioTracks().includes(track)) current.addTrack(track);
        track.onended = () => {
            if (this.state.remoteStream === current) current.removeTrack(track);
        };
        return current;
    }
    private async createAndSendOffer(generation: number, connection: RTCPeerConnection | undefined, callID: string): Promise<void> {
        if (!connection || !this.isCurrentGeneration(generation) || this.connection !== connection || connection.signalingState === 'closed') return;
        if (connection.signalingState !== 'stable') {
            this.localRenegotiationPending = true;
            return;
        }
        try {
            const offer = await connection.createOffer();
            if (!this.isCurrentGeneration(generation) || this.connection !== connection) return;
            if (offer.type !== 'offer' || typeof offer.sdp !== 'string') throw new Error('offer unavailable');
            await connection.setLocalDescription(offer);
            if (!this.isCurrentGeneration(generation) || this.connection !== connection) return;
            this.sendSignal({type: 'offer', sdp: offer.sdp}, generation, callID);
        } catch {
            if (this.isCurrentGeneration(generation)) this.setError('Could not update the call media.', generation);
        }
    }
    private async requestMicrophone(deviceID?: string, endCallOnError = true, generation = this.callGeneration): Promise<MediaStream | undefined> {
        if (!window.isSecureContext) return this.microphoneFailure('Microphone access requires a secure HTTPS connection.', endCallOnError, generation);
        if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return this.microphoneFailure('This browser does not support microphone access.', endCallOnError, generation);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: deviceID ? {deviceId: {exact: deviceID}} : true});
            if (!this.isCurrentGeneration(generation)) {
                this.stopStream(stream);
                return undefined;
            }
            const track = stream.getAudioTracks()[0];
            this.setState({...this.state, selectedInputDeviceID: track?.getSettings().deviceId || deviceID});
            void this.refreshDevices(generation);
            return stream;
        } catch (error: unknown) {
            return this.microphoneFailure(this.microphoneErrorLabel(error), endCallOnError, generation);
        }
    }
    private microphoneFailure(label: string, endCall: boolean, generation: number): undefined {
        if (!this.isCurrentGeneration(generation)) return undefined;
        if (endCall) this.setError(label, generation);
        else this.setState({...this.state, statusLabel: label, errorLabel: label});
        return undefined;
    }
    private microphoneErrorLabel(error: unknown): string {
        const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Microphone permission was denied. Allow microphone access for this site and try again.';
        if (name === 'SecurityError') return 'Microphone access is blocked by browser security settings.';
        if (name === 'NotFoundError') return 'No microphone was found. Connect a microphone and try again.';
        if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is unavailable. Close other apps using it and try again.';
        return 'Microphone access is unavailable. Check the browser permission and microphone, then try again.';
    }
    private terminal(label: string, generation: number): void {
        if (!this.isCurrentGeneration(generation)) return;
        this.retireCurrentCall();
        this.invalidateCallGeneration();
        this.cleanup();
        this.setState({phase: 'ended', muted: false, screenShareQuality: this.state.screenShareQuality, screenShareAudioEnabled: this.state.screenShareAudioEnabled, screenShareAudioActive: false, screenShareTransition: false, statusLabel: label});
        this.dismissNotice();
    }
    private setError(label: string, generation = this.callGeneration): void {
        if (!this.isCurrentGeneration(generation)) return;
        const callID = this.state.callID;
        if (callID && this.state.phase !== 'requesting') {
            const type = this.state.phase === 'incoming' ? 'call.decline' : 'call.end';
            this.dataProvider.send({type, request_id: createRandomID(), payload: {call_id: callID}});
        }
        this.retireCurrentCall();
        this.invalidateCallGeneration();
        this.cleanup();
        this.setState({phase: 'error', muted: false, screenShareQuality: this.state.screenShareQuality, screenShareAudioEnabled: this.state.screenShareAudioEnabled, screenShareAudioActive: false, screenShareTransition: false, statusLabel: label, errorLabel: label});
        this.dismissNotice();
    }
    private async tryPlayRemoteAudio(audio: HTMLAudioElement, generation: number): Promise<void> {
        try {
            if (!this.isCurrentGeneration(generation)) return;
            if (this.state.remoteStream && audio.srcObject !== this.state.remoteStream) audio.srcObject = this.state.remoteStream;
            audio.autoplay = true;
            audio.muted = false;
            audio.volume = 1;
            if (this.outputSelectionSupported && this.selectedOutputDeviceID) await this.applyOutputDevice(audio, this.selectedOutputDeviceID, generation);
            await audio.play();
            if (!this.isCurrentGeneration(generation)) return;
            this.setState({...this.state, audioPlaybackBlocked: false, statusLabel: 'Audio call connected.'});
        } catch (error: unknown) {
            if (!this.isCurrentGeneration(generation)) return;
            const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
            if (name === 'NotAllowedError') this.setState({...this.state, audioPlaybackBlocked: true, statusLabel: 'Audio connected. Enable sound to hear the call.'});
            else this.setState({...this.state, statusLabel: 'Audio connected, but speaker playback failed.'});
        }
    }
    private async applyOutputDevice(audio: HTMLAudioElement, deviceID: string, generation = this.callGeneration): Promise<boolean> {
        if (!this.isCurrentGeneration(generation)) return false;
        const selectableAudio = audio as HTMLAudioElement & {setSinkId?: (sinkID: string) => Promise<void>};
        if (typeof selectableAudio.setSinkId !== 'function') {
            if (this.isCurrentGeneration(generation)) this.setState({...this.state, outputSelectionSupported: false, statusLabel: 'This browser does not support speaker selection.'});
            return false;
        }
        try {
            await selectableAudio.setSinkId(deviceID);
            return this.isCurrentGeneration(generation);
        } catch {
            if (this.isCurrentGeneration(generation)) this.setState({...this.state, outputSelectionSupported: true, statusLabel: 'Could not change the speaker.'});
            return false;
        }
    }
    private async refreshDevices(generation = this.callGeneration): Promise<void> {
        if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            if (!this.isCurrentGeneration(generation)) return;
            const inputDevices = devices.filter(device => device.kind === 'audioinput').map(device => ({deviceID: device.deviceId, label: device.label || 'Microphone'}));
            const outputDevices = devices.filter(device => device.kind === 'audiooutput').map(device => ({deviceID: device.deviceId, label: device.label || 'Speaker'}));
            const outputSelectionSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
            const selectedInputDeviceID = inputDevices.some(device => device.deviceID === this.selectedInputDeviceID) ? this.selectedInputDeviceID : inputDevices[0]?.deviceID;
            const selectedOutputDeviceID = outputSelectionSupported && outputDevices.some(device => device.deviceID === this.selectedOutputDeviceID) ? this.selectedOutputDeviceID : undefined;
            this.setState({...this.state, inputDevices, outputDevices, selectedInputDeviceID, selectedOutputDeviceID, outputSelectionSupported});
        } catch {
            // Device enumeration is best-effort; active media tracks remain usable.
        }
    }
    private cleanup(): void {
        const screenTracks = this.state.screenShareStream?.getTracks() || [];
        screenTracks.forEach(track => track.onended = null);
        this.stopStream(this.state.localStream);
        this.stopStream(this.state.screenShareStream);
        this.connection?.close();
        this.connection = undefined;
        this.screenSender = undefined;
        this.screenAudioSender = undefined;
        this.remoteScreenStream = undefined;
        this.remoteScreenSharing = false;
        this.pendingSignals = [];
        this.pendingCandidates = [];
        this.remoteDescriptionReady = false;
        this.localRenegotiationPending = false;
        this.remoteAudio?.pause();
        if (this.remoteAudio) this.remoteAudio.srcObject = null;
        this.remoteAudio = undefined;
    }
    private stopStream(stream?: MediaStream): void { stream?.getTracks().forEach(track => track.stop()); }
    private dismissNotice(): void {
        this.clearDismissTimer();
        this.dismissTimer = window.setTimeout(() => { this.dismissTimer = undefined; this.setState(idleState); }, callNoticeDuration);
    }
    private clearDismissTimer(): void { window.clearTimeout(this.dismissTimer); this.dismissTimer = undefined; }
    private canStart(): boolean { return ['idle', 'ended', 'error'].includes(this.state.phase); }
    private matches(callID: string): boolean { return this.state.callID === callID; }
    private isCurrentGeneration(generation: number): boolean { return generation === this.callGeneration; }
    private beginCallGeneration(): number {
        this.callGeneration += 1;
        this.pendingRequestGenerations.clear();
        this.signalingChain = Promise.resolve();
        return this.callGeneration;
    }
    private invalidateCallGeneration(): void {
        this.callGeneration += 1;
        this.pendingRequestGenerations.clear();
        this.signalingChain = Promise.resolve();
        this.pendingCandidates = [];
        this.remoteDescriptionReady = false;
        this.localRenegotiationPending = false;
    }
    private retireCurrentCall(): void {
        const callID = this.state.callID;
        if (!callID) return;
        this.retiredCallIDs.add(callID);
        while (this.retiredCallIDs.size > 32) {
            const oldest = this.retiredCallIDs.values().next();
            if (oldest.done || oldest.value === undefined) break;
            this.retiredCallIDs.delete(oldest.value);
        }
    }
    private isRetiredCall(callID: string): boolean { return this.retiredCallIDs.has(callID); }
    private clearPendingRequests(generation: number, type?: string): void {
        for (const [requestID, request] of this.pendingRequestGenerations) {
            if (request.generation === generation && (!type || request.type === type)) this.pendingRequestGenerations.delete(requestID);
        }
    }
    private sendRequest(event: ClientSocketEvent, generation: number): boolean {
        if (!this.isCurrentGeneration(generation)) return false;
        this.prunePendingRequests();
        if ('request_id' in event) this.pendingRequestGenerations.set(event.request_id, {generation, type: event.type, createdAt: Date.now()});
        if (this.dataProvider.send(event)) return true;
        if ('request_id' in event) this.pendingRequestGenerations.delete(event.request_id);
        this.setError('The secure connection is unavailable.', generation);
        return false;
    }
    private prunePendingRequests(now = Date.now()): void {
        for (const [requestID, request] of this.pendingRequestGenerations) {
            const lifetime = request.type === 'call.signal' ? 15_000 : 60_000;
            if (now - request.createdAt > lifetime) this.pendingRequestGenerations.delete(requestID);
        }
        while (this.pendingRequestGenerations.size > 128) {
            const oldest = this.pendingRequestGenerations.keys().next();
            if (oldest.done || oldest.value === undefined) break;
            this.pendingRequestGenerations.delete(oldest.value);
        }
    }
    private enqueueSignaling(operation: () => Promise<void>): Promise<void> {
        const next = this.signalingChain.then(operation);
        this.signalingChain = next.catch(() => undefined);
        return next;
    }
    private isPolite(): boolean { return this.state.role === 'recipient'; }
    private sendSignal(signal: CallSignal, generation = this.callGeneration, callID = this.state.callID): void {
        if (!callID || !this.isCurrentGeneration(generation)) return;
        this.sendRequest({type: 'call.signal', request_id: createRandomID(), payload: {call_id: callID, signal}}, generation);
    }
    private sendControl(type: 'call.decline' | 'call.cancel' | 'call.end', label: string): void {
        const generation = this.callGeneration;
        const callID = this.state.callID;
        if (callID && !this.sendRequest({type, request_id: createRandomID(), payload: {call_id: callID}}, generation)) return;
        this.terminal(label, generation);
    }
    private peerFor(payload: CallPayload): string { return this.state.role === 'caller' ? payload.recipient_id : payload.caller_id; }
    private rejectionLabel(error: string): string { const value = error.toLowerCase(); return value.includes('busy') ? 'The recipient is busy.' : value.includes('answer') || value.includes('timeout') ? 'No answer.' : `Call unavailable: ${error}`; }
    private setState(state: CallState): void { this.stateSubject.next(Object.freeze({...state})); }
}
