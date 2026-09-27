import {Subject} from 'rxjs';
import {CallFacade} from './call-facade.service';
import {CallSignal, DataProviderService, MessageSocketEvent, WEBSOCKET_PROTOCOL_VERSION} from './data-provider.service';

describe('CallFacade', () => {
    let events: Subject<MessageSocketEvent>;
    let send: jasmine.Spy;
    let facade: CallFacade;
    let readyChanges: Subject<boolean>;
    let stream: MockStream;
    let connections: MockPeerConnection[];
    let originalMediaDevices: PropertyDescriptor | undefined;
    let originalPeerConnection: unknown;

    beforeEach(() => {
        events = new Subject<MessageSocketEvent>();
        readyChanges = new Subject<boolean>();
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
        facade = new CallFacade({getObservable: () => events.asObservable(), readyChanges: readyChanges.asObservable(), send} as unknown as DataProviderService);
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

    it('cleans up microphone state when call.start cannot be queued', async () => {
        send.and.returnValue(false);

        await facade.start('conversation-1', 'peer-1');

        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('The secure connection is unavailable.');
        expect(facade.state.localStream).toBeUndefined();
        expect(stream.track.stop).toHaveBeenCalled();
    });

    it('does not leave an incoming call stuck in connecting when accept cannot be queued', () => {
        events.next(incoming());
        send.and.returnValue(false);

        facade.accept();

        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('The secure connection is unavailable.');
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
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

    it('adopts a matching accepted event that arrives before the caller publishes ringing', async () => {
        send.and.callFake(event => {
            if (event.type === 'call.start') events.next(accepted());
            return true;
        });

        await facade.start('conversation-1', 'peer-1');
        await flush();

        expect(facade.state.callID).toBe('call-1');
        expect(facade.state.phase).toBe('connecting');
        expect(connections).toHaveSize(1);
        expect(send.calls.allArgs().some(([event]) => event.type === 'call.signal' && event.payload.signal.type === 'offer')).toBeTrue();
    });

    it('rejects an early accepted event for a different outgoing conversation', async () => {
        send.and.callFake(event => {
            if (event.type === 'call.start') {
                events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.accepted', payload: {...callPayload('active'), conversation_id: 'stale-conversation', ice_servers: [{urls: ['turn:turn.example.test:3478'], username: 'user', credential: 'credential'}]}});
            }
            return true;
        });

        await facade.start('conversation-1', 'peer-1');
        await flush();

        expect(facade.state.callID).toBeUndefined();
        expect(facade.state.phase).toBe('outgoing');
        expect(connections).toHaveSize(0);
    });

    it('handles a synchronous ringing event after starting a call', async () => {
        send.and.callFake(event => {
            if (event.type === 'call.start') events.next(ringing());
            return true;
        });

        await facade.start('conversation-1', 'peer-1');

        expect(facade.state.callID).toBe('call-1');
        expect(facade.state.statusLabel).toBe('Ringing...');
    });

    it('handles a synchronous accepted event after accepting a call', async () => {
        events.next(incoming());
        send.and.callFake(event => {
            if (event.type === 'call.accept') events.next(accepted());
            return true;
        });

        facade.accept();
        await flush();

        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({audio: true});
        expect(connections).toHaveSize(1);
    });

    it('cleans up a pending outgoing call when realtime is lost before ringing', async () => {
        await facade.start('conversation-1', 'peer-1');

        readyChanges.next(false);

        expect(facade.state.phase).toBe('error');
        expect(stream.track.stop).toHaveBeenCalled();
        events.next(ringing());

        expect(send.calls.allArgs().some(([event]) => event.type === 'call.cancel' && event.payload.call_id === 'call-1')).toBeTrue();
    });

    it('declines an incoming call when realtime is lost before accept', () => {
        events.next(incoming());

        readyChanges.next(false);

        expect(send.calls.allArgs().some(([event]) => event.type === 'call.decline' && event.payload.call_id === 'call-1')).toBeTrue();
        expect(facade.state.phase).toBe('error');
    });

    it('dismisses an offline-call rejection after showing one error notice', async () => {
        jasmine.clock().install();
        await facade.start('conversation-1', 'peer-1');
        const requestID = send.calls.mostRecent().args[0].request_id as string;

        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', request_id: requestID, payload: {error: 'recipient is offline'}});

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

        await facade.selectOutputDevice('');

        expect(setSinkId).toHaveBeenCalledWith('');
        expect(facade.selectedOutputDeviceID).toBe('');
    });

    it('shares the screen with the selected quality and renegotiates media', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);

        await facade.selectScreenShareQuality('2k');
        await facade.toggleScreenShare();

        const displayOptions = (navigator.mediaDevices.getDisplayMedia as jasmine.Spy).calls.mostRecent().args[0] as DisplayMediaStreamOptions & {selfBrowserSurface?: string; surfaceSwitching?: string; monitorTypeSurfaces?: string; systemAudio?: string; windowAudio?: string};
        expect(displayOptions).toEqual({video: {width: {ideal: 2560}, height: {ideal: 1440}, frameRate: {ideal: 30, max: 30}}, audio: false, selfBrowserSurface: 'include', surfaceSwitching: 'include', monitorTypeSurfaces: 'include', systemAudio: 'include', windowAudio: 'system'});
        expect(facade.state.screenShareStream).toBeTruthy();
        expect(facade.state.screenShareQuality).toBe('2k');
        expect(send.calls.allArgs().some(([event]) => event.type === 'call.signal' && event.payload.signal.type === 'offer')).toBeTrue();
    });

    it('requests, forwards, and removes optional display audio with the screen share', async () => {
        const screen = new MockScreenStream(true);
        (navigator.mediaDevices.getDisplayMedia as jasmine.Spy).and.returnValue(Promise.resolve(screen));
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);
        facade.setScreenShareAudioEnabled(true);

        await facade.toggleScreenShare();

        expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith(jasmine.objectContaining({audio: true, systemAudio: 'include', windowAudio: 'system'}));
        expect(facade.state.screenShareAudioEnabled).toBeTrue();
        expect(facade.state.screenShareAudioActive).toBeTrue();
        const audioTrack = screen.audioTrack! as unknown as MediaStreamTrack;
        const audioSender = connections[0].getSenders().find(sender => sender.track === audioTrack) as unknown as {replaceTrack: jasmine.Spy};
        expect(audioSender).toBeTruthy();

        await facade.toggleScreenShare();

        expect(audioSender.replaceTrack).toHaveBeenCalledWith(null);
        expect(facade.state.screenShareAudioActive).toBeFalse();
    });

    it('continues a selected share without audio when the browser returns no display-audio track', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);
        facade.setScreenShareAudioEnabled(true);

        await facade.toggleScreenShare();

        expect(facade.state.screenShareAudioActive).toBeFalse();
        expect(facade.state.statusLabel).toBe('You are sharing your screen. System audio was not available.');
    });

    it('mixes a display-audio track into existing remote call audio', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        const microphone = new MockRemoteAudioStream();
        const displayAudio = new MockRemoteAudioStream();
        const audio = {play: jasmine.createSpy('play').and.returnValue(Promise.resolve()), pause: jasmine.createSpy('pause'), srcObject: undefined} as unknown as HTMLAudioElement;
        facade.playRemoteAudio({currentTarget: audio} as unknown as Event);

        connections[0].ontrack?.({streams: [microphone], track: microphone.track} as unknown as RTCTrackEvent);
        connections[0].ontrack?.({streams: [displayAudio], track: displayAudio.track} as unknown as RTCTrackEvent);
        await flush();

        expect(facade.state.remoteStream).toBe(microphone as unknown as MediaStream);
        expect(microphone.addTrack).toHaveBeenCalledWith(displayAudio.track as unknown as MediaStreamTrack);
        expect(audio.srcObject).toBe(microphone as unknown as MediaStream);
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

    it('queues candidates until the remote description is installed', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        events.next(signal('call-1', {type: 'candidate', candidate: {candidate: 'candidate'}}));
        await flush();
        expect(connections[0].addIceCandidate).not.toHaveBeenCalled();
        events.next(signal('call-1', {type: 'offer', sdp: 'offer-sdp'}));
        await flush();

        expect(connections[0].remoteDescription).toEqual({type: 'offer', sdp: 'offer-sdp'});
        expect(connections[0].addIceCandidate).toHaveBeenCalledWith({candidate: 'candidate'});
    });

    it('releases the server call when signaling fails and leaves retryable local state', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        events.next(signal('call-1', {type: 'offer', sdp: 'offer-sdp'}));
        await flush();
        connections[0].addIceCandidate.and.returnValue(Promise.reject(new Error('candidate failed')));
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);

        events.next(signal('call-1', {type: 'candidate', candidate: {candidate: 'bad'}}));
        await flush();

        expect(send.calls.allArgs().some(([event]) => event.type === 'call.end' && event.payload.call_id === 'call-1')).toBeTrue();
        expect(facade.state.phase).toBe('error');
        await facade.start('conversation-1', 'peer-1');
        expect(send.calls.allArgs().some(([event]) => event.type === 'call.start')).toBeTrue();
    });

    it('ignores a late readiness loss and rejection from a retired call when a new call is starting', async () => {
        await facade.start('conversation-1', 'peer-1');
        const firstRequestID = send.calls.mostRecent().args[0].request_id as string;
        events.next(ringing());
        facade.end();
        await facade.start('conversation-1', 'peer-1');
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', request_id: firstRequestID, payload: {error: 'busy'}});

        expect(facade.state.phase).toBe('outgoing');
    });

    it('stops a display stream that resolves after the call has been closed', async () => {
        let resolveDisplay: (stream: MediaStream) => void = () => undefined;
        const pendingDisplay = new Promise<MediaStream>(resolve => { resolveDisplay = resolve; });
        (navigator.mediaDevices.getDisplayMedia as jasmine.Spy).and.returnValue(pendingDisplay);
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);

        const toggle = facade.toggleScreenShare();
        await flush();
        facade.close();
        const screen = new MockScreenStream();
        resolveDisplay(screen as unknown as MediaStream);
        await toggle;

        expect(screen.track.stop).toHaveBeenCalled();
        expect(facade.state.phase).toBe('idle');
    });

    it('ignores a display-picker rejection from a retired call', async () => {
        let rejectDisplay: (error: unknown) => void = () => undefined;
        const pendingDisplay = new Promise<MediaStream>((_, reject) => { rejectDisplay = reject; });
        (navigator.mediaDevices.getDisplayMedia as jasmine.Spy).and.returnValue(pendingDisplay);
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);

        const toggle = facade.toggleScreenShare();
        await flush();
        facade.close();
        rejectDisplay(new DOMException('picker closed', 'NotReadableError'));
        await toggle;

        expect(facade.state.phase).toBe('idle');
        expect(facade.state.errorLabel).toBeUndefined();
    });

    it('reoffers a polite peer media change after an offer collision', async () => {
        events.next(incoming());
        facade.accept();
        events.next(accepted());
        await flush();
        connections[0].ontrack?.({streams: [stream]} as unknown as RTCTrackEvent);
        connections[0].signalingState = 'have-local-offer';

        await facade.toggleScreenShare();
        expect(send.calls.allArgs().filter(([event]) => event.type === 'call.signal' && event.payload.signal.type === 'offer')).toHaveSize(0);

        events.next(signal('call-1', {type: 'offer', sdp: 'remote-offer'}));
        await flush();

        expect(send.calls.allArgs().some(([event]) => event.type === 'call.signal' && event.payload.signal.type === 'answer')).toBeTrue();
        expect(send.calls.allArgs().filter(([event]) => event.type === 'call.signal' && event.payload.signal.type === 'offer')).toHaveSize(1);
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
    public readonly audioTrack?: MockRemoteAudioTrack;
    public constructor(withAudio = false) { this.audioTrack = withAudio ? new MockRemoteAudioTrack() : undefined; }
    public getTracks(): MediaStreamTrack[] { return [this.track as unknown as MediaStreamTrack, ...(this.audioTrack ? [this.audioTrack as unknown as MediaStreamTrack] : [])]; }
    public getVideoTracks(): MediaStreamTrack[] { return [this.track as unknown as MediaStreamTrack]; }
    public getAudioTracks(): MediaStreamTrack[] { return this.audioTrack ? [this.audioTrack as unknown as MediaStreamTrack] : []; }
}

class MockRemoteAudioTrack {
    public readonly kind = 'audio';
    public onended: ((event?: Event) => void) | null = null;
    public readonly stop = jasmine.createSpy('stop').and.callFake(() => this.onended?.());
}

class MockRemoteAudioStream {
    public readonly track = new MockRemoteAudioTrack();
    private readonly tracks = [this.track];
    public readonly addTrack = jasmine.createSpy('addTrack').and.callFake((track: MockRemoteAudioTrack) => this.tracks.push(track));
    public readonly removeTrack = jasmine.createSpy('removeTrack').and.callFake((track: MockRemoteAudioTrack) => this.tracks.splice(this.tracks.indexOf(track), 1));
    public getTracks(): MediaStreamTrack[] { return this.tracks as unknown as MediaStreamTrack[]; }
    public getAudioTracks(): MediaStreamTrack[] { return this.tracks as unknown as MediaStreamTrack[]; }
}

class MockPeerConnection {
    public onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
    public ontrack: ((event: RTCTrackEvent) => void) | null = null;
    public onconnectionstatechange: (() => void) | null = null;
    public connectionState: RTCPeerConnectionState = 'new';
    public signalingState: RTCSignalingState = 'stable';
    public localDescription?: RTCSessionDescriptionInit;
    public remoteDescription?: RTCSessionDescriptionInit;
    public close = jasmine.createSpy('close');
    public constructor(public readonly configuration: RTCConfiguration) {}
    public readonly sender = {track: null as MediaStreamTrack | null, replaceTrack: jasmine.createSpy('replaceTrack').and.returnValue(Promise.resolve())};
    private readonly senders = [this.sender];
    public addTrack(track: MediaStreamTrack): RTCRtpSender {
        if (track.kind === 'audio' && this.sender.track === null) this.sender.track = track;
        else this.senders.push({track, replaceTrack: jasmine.createSpy('replaceTrack').and.returnValue(Promise.resolve())});
        return this.senders[this.senders.length - 1] as unknown as RTCRtpSender;
    }
    public getSenders(): RTCRtpSender[] { return this.senders as unknown as RTCRtpSender[]; }
    public async createOffer(): Promise<RTCSessionDescriptionInit> { return {type: 'offer', sdp: 'offer-sdp'}; }
    public async createAnswer(): Promise<RTCSessionDescriptionInit> { return {type: 'answer', sdp: 'answer-sdp'}; }
    public async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
        if (description?.type === 'rollback') this.signalingState = 'stable';
        else if (description?.type === 'answer') { this.localDescription = description; this.signalingState = 'stable'; }
        else { this.localDescription = description || {type: 'offer', sdp: 'offer-sdp'}; this.signalingState = 'have-local-offer'; }
    }
    public async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.remoteDescription = description;
        if (description.type === 'offer') this.signalingState = 'have-remote-offer';
        else if (description.type === 'answer') this.signalingState = 'stable';
    }
    public readonly addIceCandidate = jasmine.createSpy('addIceCandidate').and.returnValue(Promise.resolve());
}

function incoming(): MessageSocketEvent { return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.incoming', payload: callPayload('ringing')}; }
function ringing(): MessageSocketEvent { return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.ringing', payload: callPayload('ringing')}; }
function accepted(): MessageSocketEvent { return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.accepted', payload: {...callPayload('active'), ice_servers: [{urls: ['turn:turn.example.test:3478'], username: 'user', credential: 'credential'}]}}; }
function signal(callID: string, value: CallSignal): MessageSocketEvent { return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.signal', payload: {call_id: callID, signal: value}}; }
function callPayload(status: 'ringing' | 'active') { return {call_id: 'call-1', conversation_id: 'conversation-1', caller_id: 'caller-1', recipient_id: 'peer-1', caller_device_id: 'device-1', status, expires_at: '2026-08-05T12:00:00Z'}; }
async function flush(): Promise<void> { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }
