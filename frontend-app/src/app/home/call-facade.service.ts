import {Injectable, OnDestroy} from '@angular/core';
import {BehaviorSubject, Subscription} from 'rxjs';
import {CallAcceptedSocketEvent, CallPayload, CallSignalSocketEvent, CallSocketEvent, DataProviderService, ICEServer} from './data-provider.service';
import {createRandomID} from '../login/login';

export type CallPhase = 'idle' | 'requesting' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended' | 'error';
export type CallRole = 'caller' | 'recipient';
export interface CallState { readonly phase: CallPhase; readonly role?: CallRole; readonly callID?: string; readonly conversationID?: string; readonly peerID?: string; readonly muted: boolean; readonly localStream?: MediaStream; readonly remoteStream?: MediaStream; readonly audioPlaybackBlocked?: boolean; readonly statusLabel: string; readonly errorLabel?: string; }
const idleState: CallState = Object.freeze({phase: 'idle', muted: false, statusLabel: 'No active call.'});
const callNoticeDuration = 5_000;

@Injectable()
export class CallFacade implements OnDestroy {
    private readonly stateSubject = new BehaviorSubject<CallState>(idleState);
    private readonly subscription: Subscription;
    private connection?: RTCPeerConnection;
    private pendingSignals: Record<string, unknown>[] = [];
    private remoteAudio?: HTMLAudioElement;
    private dismissTimer?: number;
    public readonly state$ = this.stateSubject.asObservable();

    public constructor(private readonly dataProvider: DataProviderService) {
        this.subscription = this.dataProvider.getObservable().subscribe(event => { if (event.type.startsWith('call.')) this.handleEvent(event as CallSocketEvent); });
    }
    public get state(): CallState { return this.stateSubject.value; }

    public async start(conversationID: string, peerID: string): Promise<void> {
        if (!this.canStart()) return;
        this.clearDismissTimer();
        this.setState({phase: 'requesting', role: 'caller', conversationID, peerID, muted: false, statusLabel: 'Requesting microphone access...'});
        const stream = await this.requestMicrophone();
        if (!stream) return;
        if (!this.dataProvider.send({type: 'call.start', request_id: createRandomID(), payload: {conversation_id: conversationID}})) { this.stopStream(stream); this.setError('The secure connection is unavailable.'); return; }
        this.setState({phase: 'outgoing', role: 'caller', conversationID, peerID, muted: false, localStream: stream, statusLabel: 'Calling...'});
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
    public playRemoteAudio(event: Event): void {
        const audio = event.currentTarget as HTMLAudioElement | null;
        if (!audio) return;
        this.remoteAudio = audio;
        void this.tryPlayRemoteAudio(audio);
    }
    public enableRemoteAudio(): void {
        if (this.remoteAudio) void this.tryPlayRemoteAudio(this.remoteAudio);
    }
    public close(): void {
        this.clearDismissTimer();
        const state = this.state;
        if (state.callID) {
            const type = state.phase === 'incoming' ? 'call.decline' : state.phase === 'outgoing' ? 'call.cancel' : 'call.end';
            this.dataProvider.send({type, request_id: createRandomID(), payload: {call_id: state.callID}});
        }
        this.cleanup(); this.subscription.unsubscribe(); this.setState(idleState);
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
        this.setState({phase: 'incoming', role: 'recipient', callID: payload.call_id, conversationID: payload.conversation_id, peerID: payload.caller_id, muted: false, statusLabel: 'Incoming audio call.'});
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
        if (this.state.role === 'caller') try { const offer = await this.connection!.createOffer(); await this.connection!.setLocalDescription(offer); this.sendSignal({type: offer.type, sdp: offer.sdp}); } catch { this.setError('Could not start the audio call.'); }
    }
    private async handleSignal(event: CallSignalSocketEvent): Promise<void> {
        if (!this.matches(event.payload.call_id)) return;
        if (!this.connection) { this.pendingSignals.push(event.payload.signal); return; }
        await this.applySignal(event.payload.signal);
    }
    private async applySignal(signal: Record<string, unknown>): Promise<void> {
        if (!this.connection) return;
        if (signal['type'] === 'candidate' && typeof signal['candidate'] === 'object' && signal['candidate'] !== null) { try { await this.connection.addIceCandidate(signal['candidate'] as RTCIceCandidateInit); } catch { this.setError('Could not connect the audio call.'); } return; }
        if ((signal['type'] !== 'offer' && signal['type'] !== 'answer') || typeof signal['sdp'] !== 'string') return;
        try {
            if (signal['type'] === 'offer' && this.state.role === 'recipient') { await this.connection.setRemoteDescription({type: 'offer', sdp: signal['sdp']}); const answer = await this.connection.createAnswer(); await this.connection.setLocalDescription(answer); this.sendSignal({type: answer.type, sdp: answer.sdp}); }
            else if (signal['type'] === 'answer' && this.state.role === 'caller') await this.connection.setRemoteDescription({type: 'answer', sdp: signal['sdp']});
        } catch { this.setError('Could not connect the audio call.'); }
    }
    private createConnection(iceServers: ICEServer[], localStream: MediaStream): boolean {
        try {
            this.connection = new RTCPeerConnection({iceServers});
            localStream.getTracks().forEach(track => this.connection!.addTrack(track, localStream));
            this.connection.onicecandidate = event => { if (event.candidate) this.sendSignal({type: 'candidate', candidate: event.candidate.toJSON()}); };
            this.connection.ontrack = event => {
                const remoteStream = event.streams[0] || new MediaStream([event.track]);
                this.setState({...this.state, remoteStream, audioPlaybackBlocked: false, phase: 'active', statusLabel: 'Audio call connected.'});
            };
            this.connection.onconnectionstatechange = () => { if (this.connection?.connectionState === 'failed') this.setError('Could not connect the audio call.'); };
            return true;
        } catch { this.setError('Audio calls are not supported by this browser.'); return false; }
    }
    private sendSignal(signal: Record<string, unknown>): void { const callID = this.state.callID; if (callID && !this.dataProvider.send({type: 'call.signal', request_id: createRandomID(), payload: {call_id: callID, signal}})) this.setError('The secure connection is unavailable.'); }
    private sendControl(type: 'call.decline' | 'call.cancel' | 'call.end', label: string): void { const callID = this.state.callID; if (callID) this.sendCallControl(type, callID); this.terminal(label); }
    private sendCallControl(type: 'call.decline' | 'call.cancel' | 'call.end', callID: string): void { this.dataProvider.send({type, request_id: createRandomID(), payload: {call_id: callID}}); }
    private async requestMicrophone(): Promise<MediaStream | undefined> {
        if (!window.isSecureContext) { this.setError('Microphone access requires a secure HTTPS connection.'); return undefined; }
        if (typeof navigator.mediaDevices?.getUserMedia !== 'function') { this.setError('This browser does not support microphone access.'); return undefined; }
        try {
            return await navigator.mediaDevices.getUserMedia({audio: true});
        } catch (error: unknown) {
            this.setError(this.microphoneErrorLabel(error));
            return undefined;
        }
    }
    private microphoneErrorLabel(error: unknown): string {
        const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Microphone permission was denied. Allow microphone access for this site and try again.';
        if (name === 'SecurityError') return 'Microphone access is blocked by browser security settings.';
        if (name === 'NotFoundError') return 'No microphone was found. Connect a microphone and try again.';
        if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is unavailable. Close other apps using it and try again.';
        return 'Microphone access is unavailable. Check the browser permission and microphone, then try again.';
    }
    private terminal(label: string): void { this.cleanup(); this.setState({phase: 'ended', muted: false, statusLabel: label}); this.dismissNotice(); }
    private setError(label: string): void { this.cleanup(); this.setState({phase: 'error', muted: false, statusLabel: label, errorLabel: label}); this.dismissNotice(); }
    private async tryPlayRemoteAudio(audio: HTMLAudioElement): Promise<void> {
        try {
            await audio.play();
            if (this.state.audioPlaybackBlocked) this.setState({...this.state, audioPlaybackBlocked: false, statusLabel: 'Audio call connected.'});
        } catch (error: unknown) {
            const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
            if (name === 'NotAllowedError') this.setState({...this.state, audioPlaybackBlocked: true, statusLabel: 'Audio connected. Enable sound to hear the call.'});
        }
    }
    private cleanup(): void { this.stopStream(this.state.localStream); this.connection?.close(); this.connection = undefined; this.pendingSignals = []; this.remoteAudio?.pause(); if (this.remoteAudio) this.remoteAudio.srcObject = null; this.remoteAudio = undefined; }
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
