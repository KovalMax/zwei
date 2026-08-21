import {Injectable, OnDestroy} from '@angular/core';
import {BehaviorSubject, Subscription} from 'rxjs';
import {CallAcceptedSocketEvent, CallPayload, CallSignal, CallSignalSocketEvent, CallSocketEvent, DataProviderService, ICEServer} from './data-provider.service';
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
};
const idleState: CallState = Object.freeze({phase: 'idle', muted: false, screenShareQuality: '720p', screenShareTransition: false, statusLabel: 'No active call.'});
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
    private pendingSignals: CallSignal[] = [];
    private remoteScreenStream?: MediaStream;
    private remoteScreenSharing = false;
    private renegotiationChain: Promise<void> = Promise.resolve();
    private remoteAudio?: HTMLAudioElement;
    private dismissTimer?: number;
    private readonly deviceChangeListener = (): void => { void this.refreshDevices(); };
    public readonly state$ = this.stateSubject.asObservable();

    public constructor(private readonly dataProvider: DataProviderService) {
        this.subscription = this.dataProvider.getObservable().subscribe(event => { if (event.type.startsWith('call.')) this.handleEvent(event as CallSocketEvent); });
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

    public async start(conversationID: string, peerID: string): Promise<void> {
        if (!this.canStart()) return;
        this.clearDismissTimer();
        this.setState({...this.state, phase: 'requesting', role: 'caller', conversationID, peerID, muted: false, statusLabel: 'Requesting microphone access...'});
        const stream = await this.requestMicrophone();
        if (!stream) return;
        if (!this.dataProvider.send({type: 'call.start', request_id: createRandomID(), payload: {conversation_id: conversationID}})) { this.stopStream(stream); this.setError('The secure connection is unavailable.'); return; }
        this.setState({...this.state, phase: 'outgoing', role: 'caller', conversationID, peerID, muted: false, localStream: stream, statusLabel: 'Calling...'});
    }
    public accept(): void {
        const state = this.state;
        if (state.phase !== 'incoming' || !state.callID) return;
        if (!this.dataProvider.send({type: 'call.accept', request_id: createRandomID(), payload: {call_id: state.callID}})) this.setError('The secure connection is unavailable.');
        else this.setState({...state, phase: 'connecting', statusLabel: 'Connecting call...'});
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
        this.setState({...this.state, screenShareTransition: true});
        try {
            if (this.state.screenShareStream) await this.stopScreenShare();
            else await this.startScreenShare();
        } finally {
            this.setState({...this.state, screenShareTransition: false});
        }
    }
    public async selectScreenShareQuality(quality: ScreenShareQuality): Promise<void> {
        if (!screenShareDimensions[quality]) return;
        this.setState({...this.state, screenShareQuality: quality});
        const track = this.state.screenShareStream?.getVideoTracks()[0];
        if (!track || typeof track.applyConstraints !== 'function') return;
        try {
            await track.applyConstraints(this.screenShareConstraints(quality));
        } catch {
            this.setState({...this.state, statusLabel: 'Screen quality could not be changed.'});
        }
    }
    private async startScreenShare(): Promise<void> {
        if (this.state.phase !== 'active' || !this.connection || !this.screenShareSupported()) return;
        let stream: MediaStream;
        try {
            const displayOptions: DisplayMediaOptions = {
                video: this.screenShareConstraints(this.state.screenShareQuality),
                audio: false,
                selfBrowserSurface: 'include',
                surfaceSwitching: 'include',
                monitorTypeSurfaces: 'include',
            };
            stream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
        } catch (error: unknown) {
            const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
            if (name !== 'AbortError' && name !== 'NotAllowedError') this.setState({...this.state, statusLabel: 'Screen sharing is unavailable.', errorLabel: 'Screen sharing is unavailable.'});
            return;
        }
        const track = stream.getVideoTracks()[0];
        if (!track) {
            this.stopStream(stream);
            this.setState({...this.state, statusLabel: 'No screen was selected.'});
            return;
        }
        const sender = this.screenSender || this.connection.getSenders().find(item => item.track?.kind === 'video');
        try {
            if (sender) await sender.replaceTrack(track);
            else this.screenSender = this.connection.addTrack(track, stream);
            this.screenSender = sender || this.screenSender;
            track.onended = () => { void this.stopScreenShare(track); };
            this.setState({...this.state, screenShareStream: stream, statusLabel: 'You are sharing your screen.', errorLabel: undefined});
            this.sendSignal({type: 'screen-share-started'});
            await this.sendRenegotiationOffer();
        } catch {
            this.stopStream(stream);
            this.setState({...this.state, statusLabel: 'Screen sharing could not start.', errorLabel: 'Screen sharing could not start.'});
        }
    }
    private async stopScreenShare(track?: MediaStreamTrack): Promise<void> {
        const stream = this.state.screenShareStream;
        if (!stream || (track && !stream.getVideoTracks().includes(track))) return;
        const sender = this.screenSender || this.connection?.getSenders().find(item => item.track?.kind === 'video');
        this.setState({...this.state, screenShareStream: undefined, statusLabel: 'Screen sharing stopped.'});
        this.stopStream(stream);
        try {
            if (sender) await sender.replaceTrack(null);
            this.sendSignal({type: 'screen-share-stopped'});
            await this.sendRenegotiationOffer();
        } catch {
            this.setState({...this.state, statusLabel: 'Screen sharing could not stop.'});
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
        void this.tryPlayRemoteAudio(audio);
    }
    public enableRemoteAudio(): void {
        if (this.remoteAudio) void this.tryPlayRemoteAudio(this.remoteAudio);
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
        let replacement: MediaStream;
        try {
            replacement = await navigator.mediaDevices.getUserMedia({audio: {deviceId: {exact: deviceID}}});
        } catch (error: unknown) {
            const label = this.microphoneErrorLabel(error);
            this.setState({...this.state, statusLabel: label, errorLabel: label});
            return;
        }
        const track = replacement.getAudioTracks()[0];
        if (!track) {
            this.stopStream(replacement);
            return;
        }
        try {
            const sender = this.connection?.getSenders().find(item => item.track?.kind === 'audio');
            if (!sender) throw new Error('audio sender unavailable');
            await sender.replaceTrack(track);
            this.stopStream(this.state.localStream);
            this.setState({...this.state, localStream: replacement, selectedInputDeviceID: deviceID, errorLabel: undefined, statusLabel: 'Microphone changed.'});
            await this.refreshDevices();
        } catch {
            this.stopStream(replacement);
            this.setState({...this.state, statusLabel: 'Could not change the microphone.', errorLabel: 'Could not change the microphone.'});
        }
    }

    public async selectOutputDevice(deviceID: string): Promise<void> {
        if (!deviceID) return;
        this.setState({...this.state, selectedOutputDeviceID: deviceID});
        if (!this.remoteAudio) return;
        if (!(await this.applyOutputDevice(this.remoteAudio, deviceID))) return;
        this.setState({...this.state, selectedOutputDeviceID: deviceID, outputSelectionSupported: true, errorLabel: undefined, statusLabel: 'Speaker changed.'});
    }
    public close(): void {
        this.clearDismissTimer();
        const state = this.state;
        if (state.callID) {
            const type = state.phase === 'incoming' ? 'call.decline' : state.phase === 'outgoing' ? 'call.cancel' : 'call.end';
            this.dataProvider.send({type, request_id: createRandomID(), payload: {call_id: state.callID}});
        }
        this.cleanup(); this.subscription.unsubscribe(); this.setState(idleState);
        navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceChangeListener);
    }
    public ngOnDestroy(): void { this.close(); }

    private handleEvent(event: CallSocketEvent): void {
        if (event.type === 'call.rejected') { if (this.state.phase !== 'idle') this.setError(this.rejectionLabel(event.payload.error)); return; }
        if (event.type === 'call.incoming') { this.handleIncoming(event.payload); return; }
        if (event.type === 'call.accepted') { void this.handleAccepted(event); return; }
        if (event.type === 'call.signal') { void this.handleSignal(event); return; }
        if (event.type === 'call.ringing' && this.state.role === 'caller' && this.state.phase === 'outgoing' && this.state.conversationID === event.payload.conversation_id) {
            this.setState({...this.state, callID: event.payload.call_id, statusLabel: 'Ringing...'});
            return;
        }
        if (!this.matches(event.payload.call_id)) return;
        if (event.type === 'call.declined') this.terminal('Call declined.');
        if (event.type === 'call.ended') this.terminal(this.state.phase === 'outgoing' ? 'No answer.' : 'Call ended.');
    }
    private handleIncoming(payload: CallPayload): void {
        if (!this.canStart()) { this.dataProvider.send({type: 'call.decline', request_id: createRandomID(), payload: {call_id: payload.call_id}}); return; }
        this.clearDismissTimer();
        this.setState({...this.state, phase: 'incoming', role: 'recipient', callID: payload.call_id, conversationID: payload.conversation_id, peerID: payload.caller_id, muted: false, statusLabel: 'Incoming audio call.'});
    }
    private async handleAccepted(event: CallAcceptedSocketEvent): Promise<void> {
        const state = this.state;
        const relevant = state.callID === event.payload.call_id || (state.role === 'caller' && state.phase === 'outgoing' && state.conversationID === event.payload.conversation_id);
        if (!relevant || (state.role === 'recipient' && state.phase !== 'connecting')) return;
        let localStream = state.localStream;
        if (state.role === 'recipient') {
            localStream = await this.requestMicrophone();
            if (!localStream) {
                this.sendCallControl('call.end', event.payload.call_id);
                return;
            }
        }
        if (!localStream || !this.createConnection(event.payload.ice_servers, localStream)) return;
        this.setState({...this.state, phase: 'connecting', callID: event.payload.call_id, conversationID: event.payload.conversation_id, peerID: this.peerFor(event.payload), localStream, statusLabel: 'Connecting call...'});
        for (const signal of this.pendingSignals.splice(0)) await this.applySignal(signal);
        if (this.state.role === 'caller') await this.sendRenegotiationOffer();
    }
    private async handleSignal(event: CallSignalSocketEvent): Promise<void> {
        if (!this.matches(event.payload.call_id)) return;
        if (event.payload.signal.type === 'screen-share-stopped') {
            this.remoteScreenSharing = false;
            this.clearRemoteScreen();
            return;
        }
        if (event.payload.signal.type === 'screen-share-started') {
            this.remoteScreenSharing = true;
            this.restoreRemoteScreen();
            return;
        }
        if (!this.connection) { this.pendingSignals.push(event.payload.signal); return; }
        await this.applySignal(event.payload.signal);
    }

    private clearRemoteScreen(): void {
        this.setState({...this.state, remoteScreenStream: undefined});
    }
    private restoreRemoteScreen(): void {
        if (this.remoteScreenSharing && this.remoteScreenStream) this.setState({...this.state, remoteScreenStream: this.remoteScreenStream});
    }
    private async applySignal(signal: CallSignal): Promise<void> {
        if (!this.connection) return;
        if (signal.type === 'candidate') { try { await this.connection.addIceCandidate(signal.candidate as RTCIceCandidateInit); } catch { this.setError('Could not connect the audio call.'); } return; }
        try {
            if (signal.type === 'offer') {
                await this.connection.setRemoteDescription({type: 'offer', sdp: signal.sdp});
                const answer = await this.connection.createAnswer();
                if (answer.type !== 'answer' || typeof answer.sdp !== 'string') throw new Error('answer unavailable');
                await this.connection.setLocalDescription(answer);
                this.sendSignal({type: 'answer', sdp: answer.sdp});
                this.restoreRemoteScreen();
            }
            else if (signal.type === 'answer') await this.connection.setRemoteDescription({type: 'answer', sdp: signal.sdp});
        } catch { this.setError('Could not connect the audio call.'); }
    }
    private createConnection(iceServers: ICEServer[], localStream: MediaStream): boolean {
        try {
            this.connection = new RTCPeerConnection({iceServers});
            localStream.getTracks().forEach(track => this.connection!.addTrack(track, localStream));
            this.connection.onicecandidate = event => { if (event.candidate) this.sendSignal({type: 'candidate', candidate: event.candidate.toJSON()}); };
            this.connection.ontrack = event => {
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
                this.setState({...this.state, remoteStream, audioPlaybackBlocked: false, phase: 'active', statusLabel: 'Audio call connected.'});
                if (this.remoteAudio) {
                    this.remoteAudio.srcObject = remoteStream;
                    void this.tryPlayRemoteAudio(this.remoteAudio);
                }
            };
            this.connection.onconnectionstatechange = () => {
                if (this.connection?.connectionState === 'failed') this.setError('Could not connect the audio call.');
            };
            return true;
        } catch { this.setError('Audio calls are not supported by this browser.'); return false; }
    }
    private async sendRenegotiationOffer(): Promise<void> {
        const operation = this.renegotiationChain.then(async () => {
            const connection = this.connection;
            if (!connection) return;
            try {
                const offer = await connection.createOffer();
                if (offer.type !== 'offer' || typeof offer.sdp !== 'string') throw new Error('offer unavailable');
                await connection.setLocalDescription(offer);
                this.sendSignal({type: 'offer', sdp: offer.sdp});
                if (!await this.waitForStable(connection)) this.setError('Could not update the call media.');
            } catch {
                this.setError('Could not update the call media.');
            }
        });
        this.renegotiationChain = operation.catch(() => undefined);
        await operation;
    }
    private waitForStable(connection: RTCPeerConnection): Promise<boolean> {
        if (this.connection !== connection || connection.signalingState === 'stable' || connection.signalingState === 'closed') return Promise.resolve(true);
        const deadline = Date.now() + 5_000;
        return new Promise(resolve => {
            const check = (): void => {
                if (this.connection !== connection || connection.signalingState === 'stable' || connection.signalingState === 'closed') {
                    resolve(true);
                    return;
                }
                if (Date.now() >= deadline) {
                    resolve(false);
                    return;
                }
                window.setTimeout(check, 25);
            };
            check();
        });
    }
    private sendSignal(signal: CallSignal): void { const callID = this.state.callID; if (callID && !this.dataProvider.send({type: 'call.signal', request_id: createRandomID(), payload: {call_id: callID, signal}})) this.setError('The secure connection is unavailable.'); }
    private sendControl(type: 'call.decline' | 'call.cancel' | 'call.end', label: string): void { const callID = this.state.callID; if (callID) this.sendCallControl(type, callID); this.terminal(label); }
    private sendCallControl(type: 'call.decline' | 'call.cancel' | 'call.end', callID: string): void { this.dataProvider.send({type, request_id: createRandomID(), payload: {call_id: callID}}); }
    private async requestMicrophone(deviceID?: string, endCallOnError = true): Promise<MediaStream | undefined> {
        if (!window.isSecureContext) return this.microphoneFailure('Microphone access requires a secure HTTPS connection.', endCallOnError);
        if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return this.microphoneFailure('This browser does not support microphone access.', endCallOnError);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: deviceID ? {deviceId: {exact: deviceID}} : true});
            const track = stream.getAudioTracks()[0];
            this.setState({...this.state, selectedInputDeviceID: track?.getSettings().deviceId || deviceID});
            void this.refreshDevices();
            return stream;
        } catch (error: unknown) {
            return this.microphoneFailure(this.microphoneErrorLabel(error), endCallOnError);
        }
    }
    private microphoneFailure(label: string, endCall: boolean): undefined {
        if (endCall) this.setError(label);
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
    private terminal(label: string): void { this.cleanup(); this.setState({phase: 'ended', muted: false, screenShareQuality: this.state.screenShareQuality, screenShareTransition: false, statusLabel: label}); this.dismissNotice(); }
    private setError(label: string): void { this.cleanup(); this.setState({phase: 'error', muted: false, screenShareQuality: this.state.screenShareQuality, screenShareTransition: false, statusLabel: label, errorLabel: label}); this.dismissNotice(); }
    private async tryPlayRemoteAudio(audio: HTMLAudioElement): Promise<void> {
        try {
            if (this.state.remoteStream && audio.srcObject !== this.state.remoteStream) audio.srcObject = this.state.remoteStream;
            audio.autoplay = true;
            audio.muted = false;
            audio.volume = 1;
            if (this.outputSelectionSupported && this.selectedOutputDeviceID) await this.applyOutputDevice(audio, this.selectedOutputDeviceID);
            await audio.play();
            this.setState({...this.state, audioPlaybackBlocked: false, statusLabel: 'Audio call connected.'});
        } catch (error: unknown) {
            const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
            if (name === 'NotAllowedError') this.setState({...this.state, audioPlaybackBlocked: true, statusLabel: 'Audio connected. Enable sound to hear the call.'});
            else this.setState({...this.state, statusLabel: 'Audio connected, but speaker playback failed.'});
        }
    }
    private async applyOutputDevice(audio: HTMLAudioElement, deviceID: string): Promise<boolean> {
        const selectableAudio = audio as HTMLAudioElement & {setSinkId?: (sinkID: string) => Promise<void>};
        if (typeof selectableAudio.setSinkId !== 'function') {
            this.setState({...this.state, outputSelectionSupported: false, statusLabel: 'This browser does not support speaker selection.'});
            return false;
        }
        try {
            await selectableAudio.setSinkId(deviceID);
            return true;
        } catch {
            this.setState({...this.state, outputSelectionSupported: true, statusLabel: 'Could not change the speaker.'});
            return false;
        }
    }
    private async refreshDevices(): Promise<void> {
        if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
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
        const screenTracks = this.state.screenShareStream?.getVideoTracks() || [];
        screenTracks.forEach(track => track.onended = null);
        this.stopStream(this.state.localStream);
        this.stopStream(this.state.screenShareStream);
        this.connection?.close();
        this.connection = undefined;
        this.screenSender = undefined;
        this.remoteScreenStream = undefined;
        this.remoteScreenSharing = false;
        this.pendingSignals = [];
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
    private peerFor(payload: CallPayload): string { return this.state.role === 'caller' ? payload.recipient_id : payload.caller_id; }
    private rejectionLabel(error: string): string { const value = error.toLowerCase(); return value.includes('busy') ? 'The recipient is busy.' : value.includes('answer') || value.includes('timeout') ? 'No answer.' : `Call unavailable: ${error}`; }
    private setState(state: CallState): void { this.stateSubject.next(Object.freeze({...state})); }
}
