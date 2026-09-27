import {fakeAsync, tick} from '@angular/core/testing';
import {BehaviorSubject, Subject} from 'rxjs';
import {CallSignal, DataProviderService, GroupCallActiveSyncPayload, GroupCallParticipant, GroupCallRoomEventPayload, GroupCallRoomPayload, GroupCallRoomSocketEvent, GroupCallSyncedSocketEvent, MessageSocketEvent, WEBSOCKET_PROTOCOL_VERSION} from './data-provider.service';
import {GroupCallFacade} from './group-call-facade.service';

describe('GroupCallFacade', () => {
    let events: Subject<MessageSocketEvent>;
    let send: jasmine.Spy;
    let ready: BehaviorSubject<boolean>;
    let facade: GroupCallFacade;
    let track: {kind: string; enabled: boolean; stop: jasmine.Spy};
    let addedTrackKinds: string[];
    let addedTransceivers: Array<{kind: string; direction: RTCRtpTransceiverDirection}>;
    let mediaDevices: PropertyDescriptor | undefined;
    let peerConnectionDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
        events = new Subject<MessageSocketEvent>();
        ready = new BehaviorSubject<boolean>(true);
        send = jasmine.createSpy('send').and.returnValue(true);
        addedTrackKinds = [];
        addedTransceivers = [];
        track = {kind: 'audio', enabled: true, stop: jasmine.createSpy('stop')};
        mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
        peerConnectionDescriptor = Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection');
        Object.defineProperty(window, 'RTCPeerConnection', {configurable: true, value: class {
            public signalingState = 'stable';
            public connectionState = 'new';
            public onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
            public ontrack: ((event: RTCTrackEvent) => void) | null = null;
            public onconnectionstatechange: (() => void) | null = null;
            public addTrack(mediaTrack: MediaStreamTrack): RTCRtpSender { addedTrackKinds.push(mediaTrack.kind); return {replaceTrack: () => Promise.resolve()} as unknown as RTCRtpSender; }
            public addTransceiver(kind: string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver { addedTransceivers.push({kind, direction: init?.direction || 'sendrecv'}); return {} as RTCRtpTransceiver; }
            public getTransceivers(): RTCRtpTransceiver[] { return []; }
            public createOffer(): Promise<RTCSessionDescriptionInit> { return Promise.resolve({type: 'offer', sdp: 'offer'}); }
            public createAnswer(): Promise<RTCSessionDescriptionInit> { return Promise.resolve({type: 'answer', sdp: 'answer'}); }
            public setLocalDescription(): Promise<void> { return Promise.resolve(); }
            public setRemoteDescription(): Promise<void> { return Promise.resolve(); }
            public addIceCandidate(): Promise<void> { return Promise.resolve(); }
            public close(): void { this.connectionState = 'closed'; }
        } as unknown as typeof RTCPeerConnection});
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: jasmine.createSpy('getUserMedia').and.returnValue(Promise.resolve({getTracks: () => [track], getAudioTracks: () => [track]}))}});
        facade = new GroupCallFacade({getObservable: () => events.asObservable(), readyChanges: ready.asObservable(), get ready() { return ready.value; }, send} as unknown as DataProviderService);
    });
    afterEach(() => { facade.close(); if (mediaDevices) Object.defineProperty(navigator, 'mediaDevices', mediaDevices); if (peerConnectionDescriptor) Object.defineProperty(window, 'RTCPeerConnection', peerConnectionDescriptor); });

    it('requests media before starting and cleans it up on the terminal room event', async () => {
        await facade.start('group-1', 'self-1');
        expect(send).toHaveBeenCalledWith(jasmine.objectContaining({type: 'group.call.start', payload: {conversation_id: 'group-1'}}));

        events.next(room('group.call.started', 'active'));
        events.next(room('group.call.ended', 'ended'));

        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.statusLabel).toBe('Group call ended.');
    });

    it('sends one sync per interval and reconciles an active snapshot without new TURN credentials', fakeAsync(() => {
        void facade.start('group-1', 'self-1');
        tick();
        events.next(room('group.call.started', 'active'));
        const baseline = send.calls.count();

        tick(10_000);
        expect(send.calls.count()).toBe(baseline + 1);
        const sync = send.calls.allArgs().map(([event]) => event).find(event => event.type === 'group.call.sync');
        expect(sync).toBeDefined();
        tick(7_999);
        expect(send.calls.allArgs().filter(([event]) => event.type === 'group.call.sync')).toHaveSize(1);

        const originalRequest = sync as {request_id: string};
        events.next(synced(originalRequest.request_id, {state_revision: 4, participants: [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'}], presenter: {user_id: 'peer-1', device_id: 'peer-device'}}));
        expect(facade.state.peers.map(peer => peer.userID)).toEqual(['peer-1']);
        expect(facade.state.room?.presenter?.user_id).toBe('peer-1');

        tick(2_001);
        expect(send.calls.allArgs().filter(([event]) => event.type === 'group.call.sync')).toHaveSize(2);
    }));

    it('ignores stale and out-of-order snapshots and converges a correlated terminal snapshot', fakeAsync(() => {
        void facade.start('group-1', 'self-1');
        tick();
        events.next(room('group.call.started', 'active'));
        tick(10_000);
        const first = send.calls.allArgs().map(([event]) => event).find(event => event.type === 'group.call.sync') as {request_id: string};
        events.next(synced(first.request_id, {state_revision: 8, participants: [{user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'}]}));
        tick(10_000);
        const second = send.calls.allArgs().map(([event]) => event).filter(event => event.type === 'group.call.sync')[1] as {request_id: string};

        events.next(endedSync(first.request_id));
        events.next(synced(second.request_id, {state_revision: 7, status: 'active', participants: [{user_id: 'self-1', device_id: 'device-1'}]}));
        expect(facade.state.phase).toBe('active');
        tick(10_000);
        const third = send.calls.allArgs().map(([event]) => event).filter(event => event.type === 'group.call.sync')[2] as {request_id: string};
        events.next(endedSync(third.request_id));
        expect(facade.state.phase).toBe('ended');
        expect(track.stop).toHaveBeenCalled();
        tick(30_000);
        expect(send.calls.allArgs().filter(([event]) => event.type === 'group.call.sync')).toHaveSize(3);
    }));

    it('clears the sync timer when the socket goes offline', fakeAsync(() => {
        void facade.start('group-1', 'self-1');
        tick();
        events.next(room('group.call.started', 'active'));
        ready.next(false);
        expect(facade.state.phase).toBe('error');
        tick(30_000);
        expect(send.calls.allArgs().some(([event]) => event.type === 'group.call.sync')).toBeFalse();
    }));

    it('does not overlap a pending request and retries after a lost response at the next interval', fakeAsync(() => {
        void facade.start('group-1', 'self-1');
        tick();
        events.next(room('group.call.started', 'active'));
        tick(10_000);
        expect(syncCount()).toBe(1);
        tick(7_999);
        expect(syncCount()).toBe(1);
        tick(2_001);
        expect(syncCount()).toBe(2);
    }));

    it('applies newer room-event revisions and ignores stale events and sync snapshots', fakeAsync(() => {
        void facade.start('group-1', 'self-1');
        tick();
        events.next(room('group.call.started', 'active', 'group-1', 1, 5));
        tick(10_000);
        const request = send.calls.allArgs().map(([event]) => event).find(event => event.type === 'group.call.sync') as {request_id: string};

        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 7, [
            {user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'},
        ]));
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 6));
        events.next(synced(request.request_id, {state_revision: 6, participants: [{user_id: 'self-1', device_id: 'device-1'}]}));

        expect(facade.state.room?.participants.map(participant => participant.user_id)).toEqual(['self-1', 'peer-1']);
        expect(facade.state.peers.map(peer => peer.userID)).toEqual(['peer-1']);
        tick(10_000);
        expect(syncCount()).toBe(2);
    }));

    it('accepts a newer minimal membership-projection end without applying roster data', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            {user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'},
        ]));
        const payload = {room_id: 'room-1', generation: 1, status: 'ended' as const, state_revision: 6};
        expect(Object.keys(payload).sort()).toEqual(['generation', 'room_id', 'state_revision', 'status']);

        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload});

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
        expect(track.stop).toHaveBeenCalled();
    });

    it('rejects a minimal end for another room or with a stale revision', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5));

        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {room_id: 'another-room', generation: 1, status: 'ended', state_revision: 6}});
        events.next({version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {room_id: 'room-1', generation: 1, status: 'ended', state_revision: 5}});

        expect(facade.state.phase).toBe('active');
        expect(facade.state.room?.room_id).toBe('room-1');
        expect(track.stop).not.toHaveBeenCalled();
    });

    it('publishes the initiator call card state before the server room snapshot arrives', async () => {
        await facade.start('group-1', 'self-1');

        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.localStream).toBeDefined();
        expect(facade.state.room).toBeUndefined();
        expect(send).toHaveBeenCalledWith(jasmine.objectContaining({type: 'group.call.start'}));
    });

    it('cleans up a rejected start only for its matching request and exposes a retryable error', async () => {
        await facade.start('group-1', 'self-1');
        const requestID = sentGroupRequest('group.call.start');

        events.next(rejected('unrelated-request', 'room is busy'));
        expect(facade.state.phase).toBe('ringing');
        expect(track.stop).not.toHaveBeenCalled();

        events.next(rejected(requestID, 'room is busy'));

        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('Group call unavailable: room is busy');
        expect(facade.state.localStream).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(facade.isOngoing).toBeFalse();
    });

    it('cleans up a rejected join and ignores a rejection arriving after its generation ended', async () => {
        await facade.join(room('group.call.started', 'active').payload, 'self-1');
        const requestID = sentGroupRequest('group.call.join');

        events.next(rejected(requestID, 'membership required'));
        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('Group call unavailable: membership required');
        expect(facade.state.localStream).toBeUndefined();
        expect(track.stop).toHaveBeenCalledTimes(1);

        await facade.join(room('group.call.started', 'active').payload, 'self-1');
        const secondRequestID = sentGroupRequest('group.call.join', 1);
        facade.leave();
        events.next(rejected(secondRequestID, 'late rejection'));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.errorLabel).toBeUndefined();
    });

    it('keeps local media when the started event arrives synchronously', async () => {
        send.and.callFake(event => {
            if (event.type === 'group.call.start') events.next(room('group.call.started', 'ringing'));
            return true;
        });

        await facade.start('group-1', 'self-1');

        expect(facade.state.localStream).toBeDefined();
        expect(facade.state.room?.room_id).toBe('room-1');
    });

    it('creates the initial peer offer only when its stable user/device identity sorts first', async () => {
        await facade.start('group-1', 'z-self');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            {user_id: 'z-self', device_id: 'z-device'},
        ]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            {user_id: 'z-self', device_id: 'z-device'},
            {user_id: 'a-peer', device_id: 'a-device'},
        ]));
        await flush();

        expect(signalCount('offer')).toBe(0);
    });

    it('creates an initial peer offer when this device sorts first', async () => {
        await facade.start('group-1', 'a-self');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            {user_id: 'a-self', device_id: 'z-device'},
        ]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            {user_id: 'a-self', device_id: 'z-device'},
            {user_id: 'z-peer', device_id: 'a-device'},
        ]));
        await flush();

        expect(signalCount('offer')).toBe(1);
    });

    it('attaches the active presentation to a late peer before only the deterministic offerer sends its initial offer', async () => {
        await facade.start('group-1', 'a-self');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            {user_id: 'a-self', device_id: 'a-device'},
            {user_id: 'z-member', device_id: 'member-device'},
        ]));
        await flush();

        const videoTrack = {kind: 'video', stop: jasmine.createSpy('stop'), addEventListener: jasmine.createSpy('addEventListener')};
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
            getUserMedia: jasmine.createSpy('getUserMedia'),
            getDisplayMedia: jasmine.createSpy('getDisplayMedia').and.returnValue(Promise.resolve({getTracks: () => [videoTrack], getVideoTracks: () => [videoTrack]})),
        }});
        await facade.startPresentation('720p');
        expect(facade.state.presentation).toBeDefined();

        const offersBeforeLateJoin = signalCount('offer');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            {user_id: 'a-self', device_id: 'a-device'},
            {user_id: 'z-member', device_id: 'member-device'},
            {user_id: 'm-observer', device_id: 'observer-device'},
        ]));
        await flush();

        expect(addedTrackKinds.filter(kind => kind === 'video')).toHaveSize(2);
        expect(signalCount('offer')).toBe(offersBeforeLateJoin + 1);
    });

    it('reserves a receive-only video transceiver when a late joiner negotiates with an existing presenter', async () => {
        const activeRoom = room('group.call.started', 'active', 'group-1', 1, 1, [
            {user_id: 'm-observer', device_id: 'observer-device'},
            {user_id: 'z-member', device_id: 'member-device'},
        ]).payload;
        await facade.join({...activeRoom, presenter: {user_id: 'z-member', device_id: 'member-device'}}, 'm-observer');
        const joined = room('group.call.participant.joined', 'active', 'group-1', 1, 2, activeRoom.participants);
        events.next({...joined, payload: {...joined.payload, presenter: {user_id: 'z-member', device_id: 'member-device'}}});
        await flush();

        expect(addedTransceivers).toContain({kind: 'video', direction: 'recvonly'});
        expect(signalCount('offer')).toBe(1);
    });

    it('only adopts the matching first room snapshot and rejects stale room generations', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'other-group', 1));

        expect(facade.state.room).toBeUndefined();

        events.next(room('group.call.started', 'active', 'group-1', 2));
        events.next(room('group.call.participant.left', 'active', 'group-1', 1));

        expect(facade.state.room?.conversation_id).toBe('group-1');
        expect(facade.state.room?.generation).toBe(2);

        facade.end();
        events.next(room('group.call.started', 'active', 'group-1', 3));

        expect(facade.state.phase).toBe('ended');
    });

    it('does not start when microphone access is denied', async () => {
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))}});
        await facade.start('group-1', 'self-1');
        expect(send).not.toHaveBeenCalled();
        expect(facade.state.errorLabel).toContain('Microphone permission was denied');
    });

    it('locally aborts only a matching pending start, fences its microphone promise, and never ends the room', async () => {
        let resolveMedia: ((stream: MediaStream) => void) | undefined;
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: () => new Promise<MediaStream>(resolve => resolveMedia = resolve)}});

        const starting = facade.start('group-1', 'self-1');
        facade.abort('another-group');
        facade.abort('group-1');
        facade.abort('group-1');
        resolveMedia?.({getTracks: () => [track], getAudioTracks: () => [track]} as unknown as MediaStream);
        await starting;

        expect(send).not.toHaveBeenCalled();
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(facade.state.phase).toBe('idle');
    });

    it('clears the local call presentation when an authorized conversation removal aborts an active room', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));

        expect(facade.abort('group-1')).toBeTrue();
        expect(facade.state.phase).toBe('idle');
        expect(facade.state.room).toBeUndefined();
        expect(send.calls.allArgs().some(([event]) => event.type === 'group.call.end')).toBeFalse();
    });

    it('does not resurrect media or UI from delayed active sync and room events after local end', fakeAsync(() => {
        void facade.start('group-1', 'self-1');
        tick();
        events.next(room('group.call.started', 'active', 'group-1', 1, 5));
        tick(10_000);
        const sync = send.calls.allArgs().map(([event]) => event).find(event => event.type === 'group.call.sync') as {request_id: string};

        facade.end();
        events.next(synced(sync.request_id, {state_revision: 5, status: 'active', participants: [{user_id: 'self-1', device_id: 'device-1'}]}));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 5, [
            {user_id: 'self-1', device_id: 'device-1'}, {user_id: 'peer-1', device_id: 'peer-device'},
        ]));
        events.next(room('group.call.started', 'active', 'group-1', 1, 6));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.state.localStream).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
        expect(track.stop).toHaveBeenCalled();
        tick(30_000);
        expect(facade.state.phase).toBe('idle');
        expect(facade.state.room).toBeUndefined();
    }));

    it('keeps a group leave send failure visible instead of reporting a successful leave', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));
        send.calls.reset();
        send.and.returnValue(false);

        facade.leave();

        expect(send).toHaveBeenCalledWith(jasmine.objectContaining({type: 'group.call.leave'}));
        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('The secure connection is unavailable.');
        expect(facade.state.statusLabel).not.toBe('You left the group call.');
        expect(track.stop).toHaveBeenCalled();
    });

    it('fences a pending join for the removed conversation without sending group.call.join', async () => {
        let resolveMedia: ((stream: MediaStream) => void) | undefined;
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {getUserMedia: () => new Promise<MediaStream>(resolve => resolveMedia = resolve)}});
        const joining = facade.join(room('group.call.started', 'active').payload, 'self-1');

        expect(facade.abort('group-1')).toBeTrue();
        resolveMedia?.({getTracks: () => [track], getAudioTracks: () => [track]} as unknown as MediaStream);
        await joining;

        expect(send.calls.allArgs().some(([event]) => event.type === 'group.call.join')).toBeFalse();
        expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it('includes the server room generation in join, leave, and end commands', async () => {
        const activeRoom = room('group.call.started', 'active').payload;
        await facade.join(activeRoom, 'self-1');
        expect(sentEvent('group.call.join')?.payload.generation).toBe(activeRoom.generation);

        events.next(room('group.call.started', 'active'));
        facade.leave();
        expect(sentEvent('group.call.leave')?.payload.generation).toBe(activeRoom.generation);

        await facade.join(activeRoom, 'self-1');
        events.next(room('group.call.started', 'active'));
        facade.end();
        expect(sentEvent('group.call.end')?.payload.generation).toBe(activeRoom.generation);
    });

    it('includes the current room generation in presenter lifecycle and signal commands', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));
        const displayTrack = {kind: 'video', stop: jasmine.createSpy('stop'), addEventListener: jasmine.createSpy('addEventListener')};
        Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
            getUserMedia: jasmine.createSpy('getUserMedia').and.returnValue(Promise.resolve({getTracks: () => [track], getAudioTracks: () => [track]})),
            getDisplayMedia: jasmine.createSpy('getDisplayMedia').and.returnValue(Promise.resolve({getTracks: () => [displayTrack], getVideoTracks: () => [displayTrack]})),
        }});

        await facade.startPresentation('720p');
        expect(sentEvent('group.call.presenter.start')?.payload.generation).toBe(1);
        facade.stopPresentation();
        expect(sentEvent('group.call.presenter.stop')?.payload.generation).toBe(1);

        const sendSignal = (facade as unknown as {sendSignal: (target: GroupCallParticipant, signal: CallSignal, generation: number) => void}).sendSignal;
        sendSignal.call(facade, {user_id: 'peer-1', device_id: 'peer-device'}, {type: 'candidate', candidate: {candidate: 'candidate'}}, 1);
        expect(sentEvent('group.call.signal')?.payload.generation).toBe(1);
    });

    it('does not send a join for a room with a missing or non-positive generation', async () => {
        const invalidRoom = room('group.call.started', 'active').payload;
        await facade.join({...invalidRoom, generation: 0}, 'self-1');
        await facade.join({...invalidRoom, generation: Number.NaN}, 'self-1');
        expect(send.calls.allArgs().some(([event]) => event.type === 'group.call.join')).toBeFalse();
    });

    it('keeps the group call active and exposes sound recovery when autoplay is blocked', async () => {
        await facade.start('group-1', 'self-1');
        const audio = {autoplay: false, muted: true, volume: 0, pause: jasmine.createSpy('pause'), play: jasmine.createSpy('play').and.returnValue(Promise.reject(new DOMException('blocked', 'NotAllowedError')))} as unknown as HTMLAudioElement;

        facade.playRemoteAudio(audio);
        await flush();

        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.audioPlaybackBlocked).toBeTrue();
        expect(facade.state.statusLabel).toBe('Group audio connected. Enable sound to hear the call.');
        audio.play = jasmine.createSpy('play').and.returnValue(Promise.resolve());
        facade.enableRemoteAudio();
        await flush();

        expect(facade.state.audioPlaybackBlocked).toBeFalse();
        expect(send.calls.allArgs().some(([event]) => event.type === 'group.call.end')).toBeFalse();
    });

    it('applies a selected speaker to every rendered remote peer audio element', async () => {
        const firstPeerAudio = remoteAudio();
        const secondPeerAudio = remoteAudio();

        facade.playRemoteAudio(firstPeerAudio);
        facade.playRemoteAudio(secondPeerAudio);
        await facade.selectOutputDevice('speaker-2');

        expect(firstPeerAudio.setSinkId).toHaveBeenCalledOnceWith('speaker-2');
        expect(secondPeerAudio.setSinkId).toHaveBeenCalledOnceWith('speaker-2');
        expect(facade.state.selectedOutputID).toBe('speaker-2');
        expect(facade.state.statusLabel).toBe('Speaker changed.');

        await facade.selectOutputDevice('');

        expect(firstPeerAudio.setSinkId).toHaveBeenCalledWith('');
        expect(secondPeerAudio.setSinkId).toHaveBeenCalledWith('');
        expect(facade.state.selectedOutputID).toBe('');
    });

    it('registers each rendered audio once and releases it when its view is destroyed', async () => {
        const audio = remoteAudio();
        audio.srcObject = new MediaStream();

        facade.playRemoteAudio(audio);
        facade.playRemoteAudio(audio);
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);

        facade.unregisterRemoteAudio(audio);
        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(audio.srcObject).toBeNull();

        await facade.selectOutputDevice('speaker-2');
        expect(audio.setSinkId).not.toHaveBeenCalled();
        facade.enableRemoteAudio();
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);
    });

    it('retries playback when a recreated view registers after readiness events', async () => {
        const audio = remoteAudio();
        audio.srcObject = new MediaStream();

        // A canplay/loadedmetadata event may be delivered before Angular's
        // directive has registered the newly recreated audio element.
        facade.playRemoteAudio(audio);
        await flush();
        expect(audio.play).toHaveBeenCalledTimes(1);

        facade.registerRemoteAudio(audio);
        await flush();

        expect(audio.play).toHaveBeenCalledTimes(2);
        expect(facade.state.audioPlaybackBlocked).toBeFalse();
    });

    function sentEvent(type: string): {type: string; payload: {generation?: number}} | undefined {
        return send.calls.allArgs().map(([event]) => event as {type: string; payload: {generation?: number}}).find(event => event.type === type);
    }
    function sentGroupRequest(type: 'group.call.start' | 'group.call.join', occurrence = 0): string {
        const requests = send.calls.allArgs().map(([event]) => event as {type: string; request_id: string}).filter(event => event.type === type);
        return requests[occurrence]?.request_id ?? '';
    }
    function syncCount(): number { return send.calls.allArgs().filter(([event]) => event.type === 'group.call.sync').length; }
    function signalCount(type: CallSignal['type']): number { return send.calls.allArgs().filter(([event]) => event.type === 'group.call.signal' && event.payload.signal.type === type).length; }
});

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

function remoteAudio(): HTMLAudioElement & {setSinkId: jasmine.Spy} {
    return {
        autoplay: false,
        muted: true,
        volume: 0,
        pause: jasmine.createSpy('pause'),
        play: jasmine.createSpy('play').and.returnValue(Promise.resolve()),
        setSinkId: jasmine.createSpy('setSinkId').and.returnValue(Promise.resolve()),
    } as unknown as HTMLAudioElement & {setSinkId: jasmine.Spy};
}

function room(type: GroupCallRoomSocketEvent['type'], status: GroupCallRoomPayload['status'], conversationID = 'group-1', generation = 1, stateRevision = type === 'group.call.ended' ? 2 : 1, participants: GroupCallParticipant[] = [{user_id: 'self-1', device_id: 'device-1'}]): GroupCallRoomSocketEvent & {payload: GroupCallRoomEventPayload} {
    const payload: GroupCallRoomEventPayload = {room_id: 'room-1', conversation_id: conversationID, membership_revision: 1, generation, state_revision: stateRevision, status, expires_at: '2026-01-01T00:00:00Z', participants, ice_servers: [{urls: ['turn:turn.example.test:3478'], username: 'opaque', credential: 'opaque'}]};
    return {version: WEBSOCKET_PROTOCOL_VERSION, type, payload};
}

function synced(requestID: string, override: Partial<GroupCallActiveSyncPayload>): GroupCallSyncedSocketEvent {
    const base = room('group.call.started', 'active').payload;
    const {ice_servers: _iceServers, ...snapshot} = base;
    return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: requestID, payload: {...snapshot, status: 'active', ...override}};
}

function endedSync(requestID: string): GroupCallSyncedSocketEvent {
    return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: requestID, payload: {room_id: 'room-1', generation: 1, status: 'ended'}};
}

function rejected(requestID: string, error: string): MessageSocketEvent {
    return {version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', request_id: requestID, payload: {error}};
}
