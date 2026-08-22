import {Subject} from 'rxjs';
import {CallFacade} from './call-facade.service';
import {CallSignal, DataProviderService, MessageSocketEvent, WEBSOCKET_PROTOCOL_VERSION} from './data-provider.service';

describe('CallFacade', () => {
    let events: Subject<MessageSocketEvent>;
    let send: jasmine.Spy;
    let facade: CallFacade;
    let stream: MockStream;
    let connections: MockPeerConnection[];
    let originalMediaDevices: PropertyDescriptor | undefined;
    let originalPeerConnection: unknown;

    beforeEach(() => {
        events = new Subject<MessageSocketEvent>();
        send = jasmine.createSpy('send').and.returnValue(true);
        stream = new MockStream();
        connections = [];
        originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
        originalPeerConnection = window.RTCPeerConnection;
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
            getUserMedia: jasmine.createSpy('getUserMedia').and.returnValue(Promise.resolve(stream)),
            getDisplayMedia: jasmine.createSpy('getDisplayMedia').and.callFake(() => Promise.resolve(new MockScreenStream())),
            enumerateDevices: jasmine.createSpy('enumerateDevices').and.returnValue(Promise.resolve([
                {deviceId: 'microphone-1', kind: 'audioinput', label: 'Built-in microphone'},
                {deviceId: 'microphone-2', kind: 'audioinput', label: 'USB microphone'},
                {deviceId: 'speaker-1', kind: 'audiooutput', label: 'Built-in speakers'},
            ])),
        }});
        (window as unknown as {RTCPeerConnection: typeof RTCPeerConnection}).RTCPeerConnection = class extends MockPeerConnection { constructor(configuration: RTCConfiguration) { super(configuration); connections.push(this); } } as unknown as typeof RTCPeerConnection;
        facade = new CallFacade({getObservable: () => events.asObservable(), send} as unknown as DataProviderService);
    });

    afterEach(() => {
        facade.close();
        if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
        (window as unknown as {RTCPeerConnection: unknown}).RTCPeerConnection = originalPeerConnection;
    });

    it('does not send call.start when microphone permission is denied', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))}});

        await facade.start('conversation-1', 'peer-1');

        expect(send).not.toHaveBeenCalled();
        expect(facade.state.errorLabel).toBe('Microphone permission was denied. Allow microphone access for this site and try again.');
    });

    it('explains when the browser cannot provide a microphone instead of reporting a permission denial', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: () => Promise.reject(new DOMException('unavailable', 'NotReadableError'))}});

        await facade.start('conversation-1', 'peer-1');

        expect(send).not.toHaveBeenCalled();
        expect(facade.state.errorLabel).toBe('The microphone is unavailable. Close other apps using it and try again.');
    });

    it('ends a recipient call when microphone access fails after accept', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))}});
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();

        expect(send.calls.allArgs().some(([event]) => event.type === 'call.end' && event.payload.call_id === 'call-1')).toBeTrue();
        expect(facade.state.errorLabel).toContain('Microphone permission was denied.');
    });

    it('requests receiver microphone access only after accept and accepted ICE configuration', async () => {
        events.next(incoming());
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();

        facade.accept();
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        events.next(accepted());
        await flush();

        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({audio: true});
        expect(connections[0].configuration.iceServers).toEqual([{urls: ['turn:turn.example.test:3478'], username: 'user', credential: 'credential'}]);
    });

    it('lists audio devices and replaces the active microphone track', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();

        expect(facade.inputDevices.map(device => device.label)).toEqual(['Built-in microphone', 'USB microphone']);
        const replacement = new MockStream('microphone-2');
        (navigator.mediaDevices.getUserMedia as jasmine.Spy).and.returnValue(Promise.resolve(replacement));

        await facade.selectInputDevice('microphone-2');

        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({audio: {deviceId: {exact: 'microphone-2'}}});
        expect(connections[0].sender.replaceTrack).toHaveBeenCalledWith(replacement.track);
        expect(facade.selectedInputDeviceID).toBe('microphone-2');
    });

    it('answers a matching offer after an accepted recipient call', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();

        events.next(signal('call-1', {type: 'offer', sdp: 'offer-sdp'}));
        await flush();

        expect(connections[0].remoteDescription).toEqual({type: 'offer', sdp: 'offer-sdp'});
        expect(send.calls.allArgs().some(([event]) => event.type === 'call.signal' && event.payload.signal.type === 'answer')).toBeTrue();
    });

    it('queues an offer that arrives while recipient microphone access is pending', async () => {
        events.next(incoming());
        facade.accept();
        events.next(signal('call-1', {type: 'offer', sdp: 'offer-sdp'}));
        events.next(accepted());
        await flush();

        expect(connections[0].remoteDescription).toEqual({type: 'offer', sdp: 'offer-sdp'});
    });

    it('binds the caller to the server-assigned call ID when ringing begins', async () => {
        await facade.start('conversation-1', 'peer-1');

        events.next(ringing());

        expect(facade.state.callID).toBe('call-1');
        expect(facade.state.statusLabel).toBe('Ringing...');
    });

    it('dismisses an offline-call rejection after showing one error notice', async () => {
        jasmine.clock().install();
        await facade.start('conversation-1', 'peer-1');

        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', request_id: 'call-1', payload: {error: 'recipient is offline'}});

        expect(facade.state.statusLabel).toBe('Call unavailable: recipient is offline');
        jasmine.clock().tick(5_000);
        expect(facade.state.phase).toBe('idle');
        jasmine.clock().uninstall();
    });

    it('mutes tracks and closes the peer connection and local tracks when ended', async () => {
        await facade.start('conversation-1', 'peer-1');
        events.next(ringing());
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);

        facade.toggleMute();
        facade.end();

        expect(stream.track.enabled).toBeFalse();
        expect(stream.track.stop).toHaveBeenCalled();
        expect(connections[0].close).toHaveBeenCalled();
        expect(facade.state.statusLabel).toBe('Call ended.');
    });

    it('offers a user gesture retry when remote audio autoplay is blocked', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);
        const audio = {play: jasmine.createSpy('play').and.returnValue(Promise.reject(new DOMException('blocked', 'NotAllowedError'))), pause: jasmine.createSpy('pause'), srcObject: stream} as unknown as HTMLAudioElement;

        facade.playRemoteAudio({currentTarget: audio} as unknown as Event);
        await flush();

        expect(facade.state.audioPlaybackBlocked).toBeTrue();
        expect(facade.state.statusLabel).toBe('Audio connected. Enable sound to hear the call.');
        audio.play = jasmine.createSpy('play').and.returnValue(Promise.resolve());
        facade.enableRemoteAudio();
        await flush();

        expect(facade.state.audioPlaybackBlocked).toBeFalse();
        expect(facade.state.statusLabel).toBe('Audio call connected.');
    });

    it('attaches the received stream and restores audible playback before starting audio', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        const play = jasmine.createSpy('play').and.returnValue(Promise.resolve());
        const audio = {autoplay: false, muted: true, volume: 0, play, pause: jasmine.createSpy('pause'), srcObject: undefined} as unknown as HTMLAudioElement;

        facade.playRemoteAudio({currentTarget: audio} as unknown as Event);
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);
        await flush();

        expect(audio.srcObject).toBe(stream as unknown as MediaStream);
        expect(audio.autoplay).toBeTrue();
        expect(audio.muted).toBeFalse();
        expect(audio.volume).toBe(1);
        expect(play).toHaveBeenCalled();
    });

    it('attaches and starts remote screen playback when the video element is ready', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        const screen = new MockScreenStream();
        connections[0].ontrack?.({streams: [screen], track: screen.track} as unknown as RTCTrackEvent);
        const play = jasmine.createSpy('play').and.returnValue(Promise.resolve());
        const video = {autoplay: false, muted: false, play, srcObject: undefined} as unknown as HTMLVideoElement;

        facade.playRemoteScreen({currentTarget: video} as unknown as Event);
        await flush();

        expect(video.srcObject).toBe(screen as unknown as MediaStream);
        expect(video.autoplay).toBeTrue();
        expect(video.muted).toBeTrue();
        expect(play).toHaveBeenCalled();
    });

    it('selects a supported speaker after the remote audio element is ready', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);
        const setSinkId = jasmine.createSpy('setSinkId').and.returnValue(Promise.resolve());
        const audio = {play: jasmine.createSpy('play').and.returnValue(Promise.resolve()), pause: jasmine.createSpy('pause'), setSinkId, srcObject: stream} as unknown as HTMLAudioElement;

        facade.playRemoteAudio({currentTarget: audio} as unknown as Event);
        await flush();
        await facade.selectOutputDevice('speaker-1');

        expect(setSinkId).toHaveBeenCalledWith('speaker-1');
        expect(facade.selectedOutputDeviceID).toBe('speaker-1');
    });

    it('shares the screen with the selected quality and renegotiates media', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);

        await facade.selectScreenShareQuality('2k');
        await facade.toggleScreenShare();

        const displayOptions = (navigator.mediaDevices.getDisplayMedia as jasmine.Spy).calls.mostRecent().args[0] as DisplayMediaStreamOptions & {selfBrowserSurface?: string; surfaceSwitching?: string; monitorTypeSurfaces?: string};
        expect(displayOptions).toEqual({video: {width: {ideal: 2560}, height: {ideal: 1440}, frameRate: {ideal: 30, max: 30}}, audio: false, selfBrowserSurface: 'include', surfaceSwitching: 'include', monitorTypeSurfaces: 'include'});
        expect(facade.state.screenShareStream).toBeTruthy();
        expect(facade.state.screenShareQuality).toBe('2k');
        expect(send.calls.allArgs().some(([event]) => event.type === 'call.signal' && event.payload.signal.type === 'offer')).toBeTrue();
    });

    it('stops screen sharing when the browser ends the display track', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);

        await facade.toggleScreenShare();
        const track = facade.state.screenShareStream?.getVideoTracks()[0] as unknown as MockScreenTrack;
        track.onended?.(new Event('ended'));
        await flush();

        expect(facade.state.screenShareStream).toBeUndefined();
        expect(send.calls.allArgs().some(([event]) => event.type === 'call.signal' && event.payload.signal.type === 'screen-share-stopped')).toBeTrue();
    });

    it('clears the remote screen when the peer stops sharing', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [new MockScreenStream()], track: new MockScreenTrack()} as unknown as RTCTrackEvent);
        expect(facade.state.remoteScreenStream).toBeTruthy();

        events.next(signal('call-1', {type: 'screen-share-stopped'}));

        expect(facade.state.remoteScreenStream).toBeUndefined();
    });

    it('restores a reused remote screen track after the peer starts sharing again', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        const remote = new MockScreenStream();
        connections[0].ontrack?.({streams: [remote], track: remote.track} as unknown as RTCTrackEvent);

        events.next(signal('call-1', {type: 'screen-share-stopped'}));
        expect(facade.state.remoteScreenStream).toBeUndefined();
        expect(remote.track.stop).not.toHaveBeenCalled();

        events.next(signal('call-1', {type: 'screen-share-started'}));

        expect(facade.state.remoteScreenStream).toBe(remote as unknown as MediaStream);
        expect(remote.track.stop).not.toHaveBeenCalled();
    });

    it('ignores irrelevant and malformed call events while retaining its call state', async () => {
        await facade.start('conversation-1', 'peer-1');
        events.next(signal('other-call', {type: 'offer', sdp: 'ignored'}));
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.signal', payload: {call_id: 'other-call', signal: {type: 'offer'}}} as MessageSocketEvent);

        expect(facade.state.phase).toBe('outgoing');
        expect(connections).toHaveSize(0);
    });
});

class MockStream {
    public readonly track = {kind: 'audio', enabled: true, stop: jasmine.createSpy('stop'), getSettings: () => ({deviceId: this.deviceID})};
    public constructor(private readonly deviceID = 'microphone-1') {}
    public getTracks(): MediaStreamTrack[] { return [this.track as unknown as MediaStreamTrack]; }
    public getAudioTracks(): MediaStreamTrack[] { return [this.track as unknown as MediaStreamTrack]; }
}

class MockScreenTrack {
    public readonly kind = 'video';
    public onended: ((event?: Event) => void) | null = null;
    public readonly stop = jasmine.createSpy('stop').and.callFake(() => this.onended?.());
    public readonly applyConstraints = jasmine.createSpy('applyConstraints').and.returnValue(Promise.resolve());
}

class MockScreenStream {
    public readonly track = new MockScreenTrack();
    public getTracks(): MediaStreamTrack[] { return [this.track as unknown as MediaStreamTrack]; }
    public getVideoTracks(): MediaStreamTrack[] { return [this.track as unknown as MediaStreamTrack]; }
}

class MockPeerConnection {
    public onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
    public ontrack: ((event: RTCTrackEvent) => void) | null = null;
    public onconnectionstatechange: (() => void) | null = null;
    public connectionState: RTCPeerConnectionState = 'new';
    public signalingState: RTCSignalingState = 'stable';
    public remoteDescription?: RTCSessionDescriptionInit;
    public close = jasmine.createSpy('close');
    public constructor(public readonly configuration: RTCConfiguration) {}
    public readonly sender = {track: null as MediaStreamTrack | null, replaceTrack: jasmine.createSpy('replaceTrack').and.returnValue(Promise.resolve())};
    private readonly senders = [this.sender];
    public addTrack(track: MediaStreamTrack): RTCRtpSender {
        if (track.kind === 'audio') this.sender.track = track;
        else this.senders.push({track, replaceTrack: jasmine.createSpy('replaceTrack').and.returnValue(Promise.resolve())});
        return this.senders[this.senders.length - 1] as unknown as RTCRtpSender;
    }
    public getSenders(): RTCRtpSender[] { return this.senders as unknown as RTCRtpSender[]; }
    public async createOffer(): Promise<RTCSessionDescriptionInit> { return {type: 'offer', sdp: 'offer-sdp'}; }
    public async createAnswer(): Promise<RTCSessionDescriptionInit> { return {type: 'answer', sdp: 'answer-sdp'}; }
    public async setLocalDescription(): Promise<void> {}
    public async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> { this.remoteDescription = description; }
    public async addIceCandidate(): Promise<void> {}
}

function incoming(): MessageSocketEvent { return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.incoming', payload: callPayload('ringing')}; }
function ringing(): MessageSocketEvent { return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.ringing', payload: callPayload('ringing')}; }
function accepted(): MessageSocketEvent { return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.accepted', payload: {...callPayload('active'), ice_servers: [{urls: ['turn:turn.example.test:3478'], username: 'user', credential: 'credential'}]}}; }
function signal(callID: string, value: CallSignal): MessageSocketEvent { return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.signal', payload: {call_id: callID, signal: value}}; }
function callPayload(status: 'ringing' | 'active') { return {call_id: 'call-1', conversation_id: 'conversation-1', caller_id: 'caller-1', recipient_id: 'peer-1', caller_device_id: 'device-1', status, expires_at: '2026-08-05T12:00:00Z'}; }
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }
