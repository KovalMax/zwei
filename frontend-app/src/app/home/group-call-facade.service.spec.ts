import {fakeAsync, tick} from '../../testing/vitest-timers';
import { BehaviorSubject, Subject } from 'rxjs';
import type { Mock } from 'vitest';
import { CallSignal, DataProviderService, GroupCallActiveSyncPayload, GroupCallParticipant, GroupCallRoomEventPayload, GroupCallRoomPayload, GroupCallRoomSocketEvent, GroupCallSyncedSocketEvent, MessageSocketEvent, WEBSOCKET_PROTOCOL_VERSION } from './data-provider.service';
import { GroupCallFacade } from './group-call-facade.service';

describe('GroupCallFacade', () => {
    let events: Subject<MessageSocketEvent>;
    let send: Mock;
    let ready: BehaviorSubject<boolean>;
    let facade: GroupCallFacade;
    let track: {
        kind: string;
        enabled: boolean;
        stop: Mock;
    };
    let addedTrackKinds: string[];
    let senders: Array<{
        kind: string;
        replaceTrack: Mock;
    }>;
    let peerConnections: RTCPeerConnection[];
    let addedTransceivers: Array<{
        kind: string;
        direction: RTCRtpTransceiverDirection;
    }>;
    let mediaDevices: PropertyDescriptor | undefined;
    let peerConnectionDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
        events = new Subject<MessageSocketEvent>();
        ready = new BehaviorSubject<boolean>(true);
        send = vi.fn().mockName('send').mockReturnValue(true);
        addedTrackKinds = [];
        senders = [];
        peerConnections = [];
        addedTransceivers = [];
        track = { kind: 'audio', enabled: true, stop: vi.fn().mockName('stop') };
        mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
        peerConnectionDescriptor = Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection');
        Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: class {
                public constructor() { peerConnections.push(this as unknown as RTCPeerConnection); }
                public signalingState = 'stable';
                public connectionState = 'new';
                public onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
                public ontrack: ((event: RTCTrackEvent) => void) | null = null;
                public onconnectionstatechange: (() => void) | null = null;
                public addTrack(mediaTrack: MediaStreamTrack): RTCRtpSender {
                    addedTrackKinds.push(mediaTrack.kind);
                    const replaceTrack = vi.fn().mockName('replaceTrack').mockResolvedValue(undefined);
                    senders.push({ kind: mediaTrack.kind, replaceTrack });
                    return { replaceTrack } as unknown as RTCRtpSender;
                }
                public addTransceiver(kind: string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver { addedTransceivers.push({ kind, direction: init?.direction || 'sendrecv' }); return {} as RTCRtpTransceiver; }
                public getTransceivers(): RTCRtpTransceiver[] { return []; }
                public createOffer(): Promise<RTCSessionDescriptionInit> { return Promise.resolve({ type: 'offer', sdp: 'offer' }); }
                public createAnswer(): Promise<RTCSessionDescriptionInit> { return Promise.resolve({ type: 'answer', sdp: 'answer' }); }
                public setLocalDescription(): Promise<void> { return Promise.resolve(); }
                public setRemoteDescription(): Promise<void> { return Promise.resolve(); }
                public addIceCandidate(): Promise<void> { return Promise.resolve(); }
                public close(): void { this.connectionState = 'closed'; }
            } as unknown as typeof RTCPeerConnection });
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockName('getUserMedia').mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
        facade = new GroupCallFacade({ getObservable: () => events.asObservable(), readyChanges: ready.asObservable(), get ready() { return ready.value; }, send } as unknown as DataProviderService);
    });
    afterEach(() => { facade.close(); if (mediaDevices)
        Object.defineProperty(navigator, 'mediaDevices', mediaDevices); if (peerConnectionDescriptor)
        Object.defineProperty(window, 'RTCPeerConnection', peerConnectionDescriptor); });

    it('requests media before starting and cleans it up on the terminal room event', async () => {
        await facade.start('group-1', 'self-1');
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'group.call.start', payload: { conversation_id: 'group-1' } }));

        events.next(room('group.call.started', 'active'));
        events.next(room('group.call.ended', 'ended'));

        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.statusLabel).toBe('Group call ended.');
    });

    it('discovers the selected conversation before requesting media and joins the correlated active room', async () => {
        const roomPayload = room('group.call.started', 'active', 'group-1', 4, 6, [{ user_id: 'peer-1', device_id: 'peer-device' }]).payload;
        facade.discoverAndStart('group-1', 'self-1');
        const discoveryCall = vi.mocked(send).mock.lastCall;
        if (!discoveryCall) throw new Error('Expected a discovery request.');
        const discovery = discoveryCall[0] as {
            type: string;
            request_id: string;
        };
        expect(discovery.type).toBe('group.call.discover');
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();

        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: 'unrelated', payload: { conversation_id: 'group-1', room: roomPayload } });
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery.request_id, payload: { conversation_id: 'group-1', room: roomPayload } });
        await flush();

        expect(vi.mocked(send).mock.calls.map(([event]) => event.type)).toEqual(['group.call.discover', 'group.call.join']);
        const joinCall = vi.mocked(send).mock.lastCall;
        if (!joinCall) throw new Error('Expected a join request.');
        expect((joinCall[0] as {
            payload: {
                room_id: string;
            };
        }).payload.room_id).toBe('room-1');
        expect(facade.state.phase).toBe('joining');
    });

    it('rolls back earlier peer microphone replacements when a later peer rejects the device', async () => {
        const participants: GroupCallParticipant[] = [
            {user_id: 'self-1', device_id: 'device-1'},
            {user_id: 'peer-a', device_id: 'device-a'},
            {user_id: 'peer-b', device_id: 'device-b'},
        ];
        await facade.join(room('group.call.started', 'active', 'group-1', 1, 1, participants).payload, 'self-1');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants));
        const originalTrack = track as unknown as MediaStreamTrack;
        const replacementTrack = {kind: 'audio', readyState: 'live', stop: vi.fn().mockName('replacement-stop')} as unknown as MediaStreamTrack;
        const replacement = {getTracks: () => [replacementTrack], getAudioTracks: () => [replacementTrack]} as unknown as MediaStream;
        vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(replacement);
        senders[1].replaceTrack.mockRejectedValue(new Error('peer replacement failed'));

        await facade.selectInputDevice('microphone-2');

        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(1, replacementTrack);
        expect(senders[0].replaceTrack).toHaveBeenNthCalledWith(2, originalTrack);
        expect(replacementTrack.stop).toHaveBeenCalled();
        expect(track.stop).not.toHaveBeenCalled();
        expect(peerConnections[0].connectionState).not.toBe('closed');
        expect(peerConnections[1].connectionState).toBe('closed');
        expect(facade.state.localStream).not.toBe(replacement);
        expect(facade.state.phase).toBe('active');
    });

    it('keeps a muted group call muted before attaching a replacement microphone to every peer', async () => {
        const participants: GroupCallParticipant[] = [
            {user_id: 'self-1', device_id: 'device-1'},
            {user_id: 'peer-a', device_id: 'device-a'},
            {user_id: 'peer-b', device_id: 'device-b'},
        ];
        await facade.join(room('group.call.started', 'active', 'group-1', 1, 1, participants).payload, 'self-1');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, participants));
        facade.toggleMute();
        const replacementTrack = {kind: 'audio', enabled: true, readyState: 'live', stop: vi.fn().mockName('replacement-stop')} as unknown as MediaStreamTrack;
        const replacement = {getTracks: () => [replacementTrack], getAudioTracks: () => [replacementTrack]} as unknown as MediaStream;
        vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(replacement);
        for (const sender of senders) sender.replaceTrack.mockImplementation((next: MediaStreamTrack | null) => {
            if (next === replacementTrack) expect(replacementTrack.enabled).toBe(false);
            return Promise.resolve();
        });

        await facade.selectInputDevice('microphone-2');

        expect(facade.state.muted).toBe(true);
        expect(replacementTrack.enabled).toBe(false);
        expect(senders).toHaveLength(2);
        for (const sender of senders) expect(sender.replaceTrack).toHaveBeenCalledWith(replacementTrack);
    });

    it('starts only after correlated discovery reports no room', async () => {
        facade.discoverAndStart('group-1', 'self-1');
        const discoveryCall = vi.mocked(send).mock.lastCall;
        if (!discoveryCall) throw new Error('Expected a discovery request.');
        const discovery = discoveryCall[0] as {
            request_id: string;
        };
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.discovered', request_id: discovery.request_id, payload: { conversation_id: 'group-1', room: null } });
        await flush();
        expect(vi.mocked(send).mock.calls.map(([event]) => event.type)).toEqual(['group.call.discover', 'group.call.start']);
    });

    it('rings for a fresh room started by another member immediately after the previous call ends', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'ringing', 'group-1', 1, 1));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 3));
        expect(facade.state.phase).toBe('ended');

        const newCall = room('group.call.started', 'ringing', 'group-1', 1, 1, [{ user_id: 'peer-1', device_id: 'peer-device' }]);
        events.next({ ...newCall, payload: { ...newCall.payload, room_id: 'room-2' } });
        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.room?.room_id).toBe('room-2');
        expect(facade.state.localStream).toBeUndefined();

        // The old terminal timer and delayed old-room frames cannot dismiss or
        // replace the newly offered room while the recipient decides to join.
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 4));
        await tick(5000);
        expect(facade.state.room?.room_id).toBe('room-2');
        expect(facade.state.phase).toBe('ringing');
    }));

    it('allows a departed participant to rejoin the same active room without starting another call', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();

        expect(sentEvent('group.call.leave')?.payload.generation).toBe(1);
        expect(facade.state.phase).toBe('left');
        expect(facade.state.localStream).toBeUndefined();
        expect(track.stop).toHaveBeenCalled();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 2, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        expect(track.stop).toHaveBeenCalled();
        expect(facade.state.phase).toBe('left');
        expect(facade.state.localStream).toBeUndefined();
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(facade.canRejoin('another-group')).toBe(false);
        facade.rejoin('self-1');
        await flush();
        const joinRequest = sentGroupRequest('group.call.join');
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.start')).toHaveLength(1);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(1);
        expect(sentEvent('group.call.join')?.payload.generation).toBe(1);
        expect(facade.state.phase).toBe('joining');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        expect(facade.state.phase).toBe('active');
        expect(facade.canRejoin('group-1')).toBe(false);
        events.next(rejected(joinRequest, 'late rejection'));
        expect(facade.state.phase).toBe('active');
    });

    it('dismisses the leave notice after five seconds while retaining the room rejoin metadata', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        expect(facade.state.phase).toBe('left');
        await tick(4999);
        expect(facade.state.phase).toBe('left');
        await tick(1);
        expect(facade.state.phase).toBe('idle');
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(facade.canRejoin('another-group')).toBe(false);
    }));

    it('dismisses the leave notice five seconds after leaving even when the socket disconnects, retaining rejoin metadata', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();

        await tick(2000);
        ready.next(false);
        expect(facade.state.phase).toBe('left');
        expect(facade.state.statusLabel).toContain('Realtime connection lost');
        expect(facade.canRejoin('group-1')).toBe(true);

        await tick(2999);
        expect(facade.state.phase).toBe('left');
        await tick(1);
        expect(facade.state.phase).toBe('idle');
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(facade.canRejoin('another-group')).toBe(false);
    }));

    it('does not block rejoin after the leave command is queued', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);
        facade.rejoin('self-1');
        await flush();
        expect(facade.state.phase).toBe('joining');
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(1);
    });

    it('clears a departed room on conversation removal or a newer incoming room', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        expect(facade.abort('another-group')).toBe(false);
        expect(facade.abort('group-1')).toBe(true);
        expect(facade.canRejoin('group-1')).toBe(false);

        await facade.start('group-1', 'self-1');
        const secondRoom = room('group.call.started', 'ringing', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]);
        events.next({ ...secondRoom, payload: { ...secondRoom.payload, room_id: 'room-2' } });
        facade.leave();
        const newRoom = room('group.call.started', 'ringing', 'group-1', 1, 1, [{ user_id: 'peer-1', device_id: 'peer-device' }]);
        events.next({ ...newRoom, payload: { ...newRoom.payload, room_id: 'room-3' } });
        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.room?.room_id).toBe('room-3');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('keeps a departed room retryable when microphone permission fails during rejoin', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });

        facade.rejoin('self-1');
        await flush();

        expect(facade.state.phase).toBe('left');
        expect(facade.state.errorLabel).toContain('Microphone permission was denied');
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.join')).toHaveLength(0);
    });

    it('clears retained room credentials on a minimal terminal event while locally left', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {
                room_id: 'room-1', generation: 1, status: 'ended', state_revision: 2,
            } });

        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('preserves the rejoin room through realtime disconnect and can retry after reconnection', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        ready.next(false);

        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);
        ready.next(true);
        facade.rejoin('self-1');
        await flush();

        expect(facade.state.phase).toBe('joining');
        expect(sentEvent('group.call.join')?.payload).toEqual(expect.objectContaining({ room_id: 'room-1' }));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 3, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        expect(facade.state.phase).toBe('active');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('ignores stale updates to a departed room while accepting its newer terminal event', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next(room('group.call.started', 'active', 'group-1', 1, 4, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);

        events.next(room('group.call.ended', 'ended', 'group-1', 1, 6));

        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('fences stale roster revisions during rejoin and delayed start events after terminal events', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        facade.rejoin('self-1');
        await flush();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 4, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        expect(facade.state.phase).toBe('joining');
        expect(facade.state.room?.participants).toHaveLength(2);

        events.next(room('group.call.ended', 'ended', 'group-1', 1, 6));
        events.next(room('group.call.started', 'active', 'group-1', 1, 7));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('retires a departed room on its minimal terminal projection before delayed room updates', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 6, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        expect(facade.state.phase).toBe('left');
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: {
                room_id: 'room-1', generation: 1, status: 'ended', state_revision: 7,
            } });
        events.next(room('group.call.started', 'active', 'group-1', 1, 7));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('reconciles a rejected leave and preserves only a retry path for a confirmed active room', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        const leaveID = sentGroupRequest('group.call.leave');
        events.next(rejected(leaveID, 'call unavailable'));

        const syncID = sentRequestID('group.call.sync');
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(false);
        events.next(synced(syncID, { state_revision: 5, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }] }));

        expect(facade.state.phase).toBe('left');
        expect(facade.state.errorLabel).toContain('Could not leave');
        expect(facade.canRejoin('group-1')).toBe(true);
        expect(facade.state.localStream).toBeUndefined();
    });

    it('keeps an ended result after a rejected end is authoritatively reconciled as ended', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.end();
        const endID = sentGroupRequest('group.call.end');
        events.next(rejected(endID, 'call unavailable'));
        const syncID = sentRequestID('group.call.sync', 1);
        events.next(endedSync(syncID));

        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('ignores an uncorrelated rejection and never overwrites a newer terminal room event', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.end();
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', payload: { error: 'call unavailable' } });
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 6, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        events.next(rejected(sentGroupRequest('group.call.end'), 'late rejection'));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.errorLabel).toBeUndefined();
        expect(facade.state.room).toBeUndefined();
    });

    it('ignores terminal projections at or below baseline while rejected-control reconciliation is pending', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next(rejected(sentGroupRequest('group.call.leave'), 'call unavailable'));
        const syncID = sentRequestID('group.call.sync');
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: { room_id: 'room-1', generation: 1, status: 'ended', state_revision: 5 } });
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 5));

        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(false);
        events.next(synced(syncID, { state_revision: 5, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }] }));
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);
    });

    it('keeps rejoin disabled when control room sync is sent unsuccessfully or rejected', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        const leaveID = sentGroupRequest('group.call.leave');
        send.mockReturnValue(false);
        events.next(rejected(leaveID, 'call unavailable'));
        expect(facade.canRejoin('group-1')).toBe(false);
        expect(facade.state.errorLabel).toContain('could not be verified');

        const unavailableSyncID = sentRequestID('group.call.sync');
        events.next(rejected(unavailableSyncID, 'sync unavailable'));
        expect(facade.canRejoin('group-1')).toBe(false);
        expect(facade.state.errorLabel).toContain('could not be verified');
    });

    it('does not retire a ringing room when a recipient leaves and may rejoin until it ends', async () => {
        const incomingRoom = room('group.call.started', 'ringing', 'group-1', 1, 1, [{ user_id: 'peer-1', device_id: 'peer-device' }]).payload;
        events.next({ ...room('group.call.started', 'ringing', 'group-1', 1, 1, incomingRoom.participants), payload: incomingRoom });
        await facade.join(incomingRoom, 'self-1');
        const pendingJoin = sentGroupRequest('group.call.join');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'peer-1', device_id: 'peer-device' }, { user_id: 'self-1', device_id: 'device-1' },
        ]));
        facade.leave();

        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);
        events.next(rejected(pendingJoin, 'leave accepted'));
        expect(facade.state.phase).toBe('left');
        expect(facade.canRejoin('group-1')).toBe(true);

        const ended = room('group.call.ended', 'ended', 'group-1', 1, 3);
        events.next({ ...ended, payload: { ...ended.payload, room_id: incomingRoom.room_id } });
        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('sends one sync per interval and reconciles an active snapshot without new TURN credentials', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'active'));
        const baseline = vi.mocked(send).mock.calls.length;

        await tick(10000);
        expect(vi.mocked(send).mock.calls.length).toBe(baseline + 1);
        const sync = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.sync');
        expect(sync).toBeDefined();
        await tick(7999);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.sync')).toHaveLength(1);

        const originalRequest = sync as {
            request_id: string;
        };
        events.next(synced(originalRequest.request_id, { state_revision: 4, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }], presenter: { user_id: 'peer-1', device_id: 'peer-device' } }));
        expect(facade.state.peers.map(peer => peer.userID)).toEqual(['peer-1']);
        expect(facade.state.room?.presenter?.user_id).toBe('peer-1');

        await tick(2001);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.sync')).toHaveLength(2);
    }));

    it('ignores stale and out-of-order snapshots and converges a correlated terminal snapshot', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'active'));
        await tick(10000);
        const first = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.sync') as {
            request_id: string;
        };
        events.next(synced(first.request_id, { state_revision: 8, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }] }));
        await tick(10000);
        const second = vi.mocked(send).mock.calls.map(([event]) => event).filter(event => event.type === 'group.call.sync')[1] as {
            request_id: string;
        };

        events.next(endedSync(first.request_id));
        events.next(synced(second.request_id, { state_revision: 7, status: 'active', participants: [{ user_id: 'self-1', device_id: 'device-1' }] }));
        expect(facade.state.phase).toBe('active');
        await tick(10000);
        const third = vi.mocked(send).mock.calls.map(([event]) => event).filter(event => event.type === 'group.call.sync')[2] as {
            request_id: string;
        };
        events.next(endedSync(third.request_id));
        expect(facade.state.phase).toBe('ended');
        expect(track.stop).toHaveBeenCalled();
        await tick(30000);
        expect(vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.sync')).toHaveLength(3);
    }));

    it('clears the sync timer when the socket goes offline', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'active'));
        ready.next(false);
        expect(facade.state.phase).toBe('error');
        await tick(30000);
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.sync')).toBe(false);
    }));

    it('does not overlap a pending request and retries after a lost response at the next interval', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'active'));
        await tick(10000);
        expect(syncCount()).toBe(1);
        await tick(7999);
        expect(syncCount()).toBe(1);
        await tick(2001);
        expect(syncCount()).toBe(2);
    }));

    it('applies newer room-event revisions and ignores stale events and sync snapshots', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'active', 'group-1', 1, 5));
        await tick(10000);
        const request = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.sync') as {
            request_id: string;
        };

        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 7, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 6));
        events.next(synced(request.request_id, { state_revision: 6, participants: [{ user_id: 'self-1', device_id: 'device-1' }] }));

        expect(facade.state.room?.participants.map(participant => participant.user_id)).toEqual(['self-1', 'peer-1']);
        expect(facade.state.peers.map(peer => peer.userID)).toEqual(['peer-1']);
        await tick(10000);
        expect(syncCount()).toBe(2);
    }));

    it('accepts a newer minimal membership-projection end without applying roster data', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        const payload = { room_id: 'room-1', generation: 1, status: 'ended' as const, state_revision: 6 };
        expect(Object.keys(payload).sort()).toEqual(['generation', 'room_id', 'state_revision', 'status']);

        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload });

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
        expect(track.stop).toHaveBeenCalled();
    });

    it('rejects a minimal end for another room or with a stale revision', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5));

        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: { room_id: 'another-room', generation: 1, status: 'ended', state_revision: 6 } });
        events.next({ version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.ended', payload: { room_id: 'room-1', generation: 1, status: 'ended', state_revision: 5 } });

        expect(facade.state.phase).toBe('active');
        expect(facade.state.room?.room_id).toBe('room-1');
        expect(track.stop).not.toHaveBeenCalled();
    });

    it('publishes the initiator call card state before the server room snapshot arrives', async () => {
        await facade.start('group-1', 'self-1');

        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.localStream).toBeDefined();
        expect(facade.state.room).toBeUndefined();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'group.call.start' }));
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
        expect(facade.isOngoing).toBe(false);
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
    });

    it('shows the explicit room participant limit when an active group call is full', async () => {
        await facade.join(room('group.call.started', 'active').payload, 'self-1');
        events.next(rejected(sentGroupRequest('group.call.join'), 'group call is full (maximum 4 participants)'));

        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('Group call unavailable: group call is full (maximum 4 participants)');
        expect(facade.state.localStream).toBeUndefined();
        expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it('keeps local media when the started event arrives synchronously', async () => {
        send.mockImplementation(event => {
            if (event.type === 'group.call.start')
                events.next(room('group.call.started', 'ringing'));
            return true;
        });

        await facade.start('group-1', 'self-1');

        expect(facade.state.localStream).toBeDefined();
        expect(facade.state.room?.room_id).toBe('room-1');
    });

    it('creates the initial peer offer only when its stable user/device identity sorts first', async () => {
        await facade.start('group-1', 'z-self');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'z-self', device_id: 'z-device' },
        ]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'z-self', device_id: 'z-device' },
            { user_id: 'a-peer', device_id: 'a-device' },
        ]));
        await flush();

        expect(signalCount('offer')).toBe(0);
    });

    it('creates an initial peer offer when this device sorts first', async () => {
        await facade.start('group-1', 'a-self');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'a-self', device_id: 'z-device' },
        ]));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'a-self', device_id: 'z-device' },
            { user_id: 'z-peer', device_id: 'a-device' },
        ]));
        await flush();

        expect(signalCount('offer')).toBe(1);
    });

    it('attaches the active presentation to a late peer before only the deterministic offerer sends its initial offer', async () => {
        await facade.start('group-1', 'a-self');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'a-self', device_id: 'a-device' },
            { user_id: 'z-member', device_id: 'member-device' },
        ]));
        await flush();

        const videoTrack = { kind: 'video', readyState: 'live', stop: vi.fn().mockName('stop'), addEventListener: vi.fn().mockName('addEventListener') };
        const audioTrack = { kind: 'audio', readyState: 'live', stop: vi.fn().mockName('stop'), addEventListener: vi.fn().mockName('addEventListener') };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                getUserMedia: vi.fn().mockName('getUserMedia'),
                getDisplayMedia: vi.fn().mockName('getDisplayMedia').mockResolvedValue({ getTracks: () => [videoTrack, audioTrack], getVideoTracks: () => [videoTrack], getAudioTracks: () => [audioTrack] }),
            } });
        facade.setScreenShareAudioEnabled(true);
        await facade.startPresentation('720p');
        expect(facade.state.presentation).toBeDefined();
        expect(facade.state.screenShareAudioActive).toBe(true);
        expect(facade.state.statusLabel).toBe('You are presenting.');
        expect(addedTrackKinds.filter(kind => kind === 'audio')).toHaveLength(2);

        const offersBeforeLateJoin = signalCount('offer');
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 2, [
            { user_id: 'a-self', device_id: 'a-device' },
            { user_id: 'z-member', device_id: 'member-device' },
            { user_id: 'm-observer', device_id: 'observer-device' },
        ]));
        await flush();

        expect(addedTrackKinds.filter(kind => kind === 'video')).toHaveLength(2);
        expect(signalCount('offer')).toBe(offersBeforeLateJoin + 1);
    });

    it('keeps video presentation usable when opted-in display capture has no audio track', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));
        const videoTrack = { kind: 'video', readyState: 'live', stop: vi.fn().mockName('stop'), addEventListener: vi.fn().mockName('addEventListener') };
        const getDisplayMedia = vi.fn().mockName('getDisplayMedia').mockResolvedValue({
            getTracks: () => [videoTrack], getVideoTracks: () => [videoTrack], getAudioTracks: () => [],
        });
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
        facade.setScreenShareAudioEnabled(true);

        await facade.startPresentation('720p');

        expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: true }));
        expect(facade.state.presentation).toBeDefined();
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.screenShareAudioActive).toBe(false);
        expect(facade.state.statusLabel).toBe('You are presenting. System audio was not available.');
    });

    it('removes only ended system audio, stops both senders on share stop, then reuses senders on restart', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'self-device' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        const firstVideo = testDisplayTrack('video');
        const firstAudio = testDisplayTrack('audio');
        const secondVideo = testDisplayTrack('video');
        const secondAudio = testDisplayTrack('audio');
        const thirdVideo = testDisplayTrack('video');
        const thirdAudio = testDisplayTrack('audio');
        const fourthVideo = testDisplayTrack('video');
        const fourthAudio = testDisplayTrack('audio');
        const streams = [
            testDisplayStream(firstVideo.track, firstAudio.track),
            testDisplayStream(secondVideo.track, secondAudio.track),
            testDisplayStream(thirdVideo.track, thirdAudio.track),
            testDisplayStream(fourthVideo.track, fourthAudio.track),
        ];
        const getDisplayMedia = vi.fn().mockName('getDisplayMedia').mockReturnValueOnce(Promise.resolve(streams[0])).mockReturnValueOnce(Promise.resolve(streams[1])).mockReturnValueOnce(Promise.resolve(streams[2])).mockReturnValueOnce(Promise.resolve(streams[3]));
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
        facade.setScreenShareAudioEnabled(true);

        await facade.startPresentation('720p');
        const videoSender = senders.find(sender => sender.kind === 'video');
        const audioSenders = senders.filter(sender => sender.kind === 'audio');
        expect(videoSender).toBeDefined();
        expect(audioSenders).toHaveLength(2); // microphone and independent presentation audio
        const presentationAudioSender = audioSenders[1];
        expect(facade.state.screenShareAudioActive).toBe(true);

        firstAudio.end();
        for (let attempt = 0; attempt < 8 && facade.state.screenShareAudioActive; attempt += 1)
            await flush();
        expect(facade.state.presentation).toBe(streams[0]);
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.screenShareAudioActive).toBe(false);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(null);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(firstVideo.track);

        await facade.stopPresentation();
        expect(facade.state.presentation).toBeUndefined();
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(null);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(null);

        await facade.startPresentation('720p');
        expect(getDisplayMedia).toHaveBeenCalledTimes(2);
        expect(senders.filter(sender => sender.kind === 'video')).toHaveLength(1);
        expect(senders.filter(sender => sender.kind === 'audio')).toHaveLength(2);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(secondVideo.track);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(secondAudio.track);
        expect(facade.state.presentation).toBe(streams[1]);
        expect(facade.state.screenShareAudioActive).toBe(true);

        await facade.stopPresentation();
        expect(facade.state.presentation).toBeUndefined();
        expect(facade.state.screenShareAudioActive).toBe(false);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(null);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(null);

        await facade.startPresentation('720p');
        expect(facade.state.presentation).toBe(streams[2]);
        expect(facade.state.screenShareAudioActive).toBe(true);

        // Browser audio/video-ended events and a user stop can land in the same
        // task. The shared lifecycle queue must serialize their renegotiations.
        thirdAudio.end();
        thirdVideo.end();
        const overlappingUserStop = facade.stopPresentation();
        await overlappingUserStop;
        await flush();
        await flush();
        expect(facade.state.presentation).toBeUndefined();
        expect(facade.state.screenShareAudioActive).toBe(false);
        expect(facade.state.shareTransitioning).toBe(false);
        expect(facade.state.peers.map(peer => peer.userID)).toContain('peer-1');
        expect(peerConnections.every(connection => connection.connectionState !== 'closed')).toBe(true);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(null);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(null);

        await facade.startPresentation('720p');
        expect(getDisplayMedia).toHaveBeenCalledTimes(4);
        expect(senders.filter(sender => sender.kind === 'video')).toHaveLength(1);
        expect(senders.filter(sender => sender.kind === 'audio')).toHaveLength(2);
        expect(videoSender?.replaceTrack).toHaveBeenCalledWith(fourthVideo.track);
        expect(presentationAudioSender.replaceTrack).toHaveBeenCalledWith(fourthAudio.track);
        expect(facade.state.presentation).toBe(streams[3]);
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.screenShareAudioActive).toBe(true);
    });

    it('never activates a display capture whose video track ended before startup continuation', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));
        const video = testDisplayTrack('video');
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                getDisplayMedia: vi.fn().mockName('getDisplayMedia').mockResolvedValue(testDisplayStream(video.track, testDisplayTrack('audio').track)),
            } });

        const startup = facade.startPresentation('720p');
        video.end();
        await startup;

        expect(facade.state.presentation).toBeUndefined();
        expect(facade.state.sharing).toBe(false);
        expect(facade.state.shareTransitioning).toBe(false);
        expect(facade.state.statusLabel).toContain('No live screen');
    });

    it('times out a stalled presenter sender, releases its tracks and peer, then allows a new share', fakeAsync(async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        const display = testDisplayTrack('video');
        const displayAudio = testDisplayTrack('audio');
        const nextDisplay = testDisplayTrack('video');
        const captures = [testDisplayStream(display.track, displayAudio.track), testDisplayStream(nextDisplay.track, testDisplayTrack('audio').track)];
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                getDisplayMedia: vi.fn().mockName('getDisplayMedia').mockResolvedValueOnce(captures[0]).mockResolvedValueOnce(captures[1]),
            } });
        const replaceTrack = vi.fn().mockName('replaceTrack').mockReturnValue(new Promise<void>(() => undefined));
        vi.spyOn(peerConnections[0], 'addTrack').mockImplementation(mediaTrack => {
            senders.push({ kind: mediaTrack.kind, replaceTrack });
            return { replaceTrack } as unknown as RTCRtpSender;
        });

        const starting = facade.startPresentation('720p');
        await tick();
        await tick(1_501);
        await starting;

        expect(facade.state.presentation).toBeUndefined();
        expect(facade.state.sharing).toBe(false);
        expect(facade.state.shareTransitioning).toBe(false);
        expect(facade.state.errorLabel).toBe('A peer connection was closed because media could not be replaced.');
        expect(display.track.stop).toHaveBeenCalled();
        expect(displayAudio.track.stop).toHaveBeenCalled();
        expect(peerConnections[0].connectionState).toBe('closed');
        expect(facade.state.peers).toEqual([]);

        await facade.startPresentation('720p');
        expect(facade.state.presentation).toBe(captures[1]);
        expect(facade.state.sharing).toBe(true);
        expect(facade.state.shareTransitioning).toBe(false);
    }));

    it('reserves a receive-only video transceiver when a late joiner negotiates with an existing presenter', async () => {
        const activeRoom = room('group.call.started', 'active', 'group-1', 1, 1, [
            { user_id: 'm-observer', device_id: 'observer-device' },
            { user_id: 'z-member', device_id: 'member-device' },
        ]).payload;
        await facade.join({ ...activeRoom, presenter: { user_id: 'z-member', device_id: 'member-device' } }, 'm-observer');
        const joined = room('group.call.participant.joined', 'active', 'group-1', 1, 2, activeRoom.participants);
        events.next({ ...joined, payload: { ...joined.payload, presenter: { user_id: 'z-member', device_id: 'member-device' } } });
        await flush();

        expect(addedTransceivers).toContainEqual({kind: 'video', direction: 'recvonly'});
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
        expect(facade.state.phase).toBe('ended');
        events.next(room('group.call.started', 'active', 'group-1', 3));

        expect(facade.state.phase).toBe('ended');
    });

    it('does not start when microphone access is denied', async () => {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
        await facade.start('group-1', 'self-1');
        expect(send).not.toHaveBeenCalled();
        expect(facade.state.errorLabel).toContain('Microphone permission was denied');
    });

    it('locally aborts only a matching pending start, fences its microphone promise, and never ends the room', async () => {
        let resolveMedia: ((stream: MediaStream) => void) | undefined;
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(resolve => resolveMedia = resolve) } });

        const starting = facade.start('group-1', 'self-1');
        facade.abort('another-group');
        facade.abort('group-1');
        facade.abort('group-1');
        resolveMedia?.({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
        await starting;

        expect(send).not.toHaveBeenCalled();
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(facade.state.phase).toBe('idle');
    });

    it('clears the local call presentation when an authorized conversation removal aborts an active room', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));

        expect(facade.abort('group-1')).toBe(true);
        expect(facade.state.phase).toBe('idle');
        expect(facade.state.room).toBeUndefined();
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.end')).toBe(false);
    });

    it('does not resurrect media or UI from delayed active sync and room events after local end', fakeAsync(async () => {
        void facade.start('group-1', 'self-1');
        await tick();
        events.next(room('group.call.started', 'active', 'group-1', 1, 5));
        await tick(10000);
        const sync = vi.mocked(send).mock.calls.map(([event]) => event).find(event => event.type === 'group.call.sync') as {
            request_id: string;
        };

        facade.end();
        const ended = room('group.call.ended', 'ended', 'group-1', 1, 6);
        events.next(ended);
        events.next(synced(sync.request_id, { state_revision: 5, status: 'active', participants: [{ user_id: 'self-1', device_id: 'device-1' }] }));
        events.next(room('group.call.participant.joined', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        events.next(room('group.call.started', 'active', 'group-1', 1, 7));

        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
        expect(facade.state.localStream).toBeUndefined();
        expect(facade.state.peers).toEqual([]);
        expect(track.stop).toHaveBeenCalled();
        await tick(30000);
        expect(facade.state.phase).toBe('idle');
        expect(facade.state.room).toBeUndefined();
    }));

    it('keeps a group leave send failure visible instead of reporting a successful leave', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));
        send.mockClear();
        send.mockReturnValue(false);

        facade.leave();

        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'group.call.leave' }));
        expect(facade.state.phase).toBe('error');
        expect(facade.state.errorLabel).toBe('The secure connection is unavailable.');
        expect(facade.state.statusLabel).not.toBe('You left the group call.');
        expect(track.stop).toHaveBeenCalled();
    });

    it('sends group-call end and retires the local call immediately', () => {
        void facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));
        facade.end();
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.end')).toBe(true);
        expect(facade.state.phase).toBe('ended');
        events.next(room('group.call.ended', 'ended', 'group-1', 1, 2));
        expect(facade.state.phase).toBe('ended');
        expect(facade.state.room).toBeUndefined();
    });

    it('ends a room on a newer full-room terminal update after local departure', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active', 'group-1', 1, 5, [
            { user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' },
        ]));
        facade.leave();
        events.next(room('group.call.participant.left', 'active', 'group-1', 1, 6, [{ user_id: 'peer-1', device_id: 'peer-device' }]));
        expect(facade.state.phase).toBe('left');

        events.next(room('group.call.ended', 'ended', 'group-1', 1, 7, [{ user_id: 'peer-1', device_id: 'peer-device' }]));

        expect(facade.state.phase).toBe('ended');
        expect(facade.canRejoin('group-1')).toBe(false);
    });

    it('fences a pending join for the removed conversation without sending group.call.join', async () => {
        let resolveMedia: ((stream: MediaStream) => void) | undefined;
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(resolve => resolveMedia = resolve) } });
        const joining = facade.join(room('group.call.started', 'active').payload, 'self-1');

        expect(facade.abort('group-1')).toBe(true);
        resolveMedia?.({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
        await joining;

        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.join')).toBe(false);
        expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it('includes the server room generation in join, leave, and end commands', async () => {
        const activeRoom = room('group.call.started', 'active').payload;
        await facade.join({ ...activeRoom, participants: [{ user_id: 'self-1', device_id: 'device-1' }, { user_id: 'peer-1', device_id: 'peer-device' }] }, 'self-1');
        expect(sentEvent('group.call.join')?.payload.generation).toBe(activeRoom.generation);

        events.next(room('group.call.started', 'active'));
        facade.end();
        expect(sentEvent('group.call.end')?.payload.generation).toBe(activeRoom.generation);
        expect(facade.state.phase).toBe('ended');

        await facade.join(activeRoom, 'self-1');
        events.next(room('group.call.started', 'active'));
        facade.leave();
        expect(sentEvent('group.call.leave')?.payload.generation).toBe(activeRoom.generation);
        expect(facade.state.phase).toBe('ended');
    });

    it('includes the current room generation in presenter lifecycle and signal commands', async () => {
        await facade.start('group-1', 'self-1');
        events.next(room('group.call.started', 'active'));
        const displayTrack = { kind: 'video', readyState: 'live', stop: vi.fn().mockName('stop'), addEventListener: vi.fn().mockName('addEventListener') };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                getUserMedia: vi.fn().mockName('getUserMedia').mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }),
                getDisplayMedia: vi.fn().mockName('getDisplayMedia').mockResolvedValue({ getTracks: () => [displayTrack], getVideoTracks: () => [displayTrack], getAudioTracks: () => [] }),
            } });

        await facade.startPresentation('720p');
        expect(sentEvent('group.call.presenter.start')?.payload.generation).toBe(1);
        await facade.stopPresentation();
        expect(sentEvent('group.call.presenter.stop')?.payload.generation).toBe(1);

        const sendSignal = (facade as unknown as {
            sendSignal: (target: GroupCallParticipant, signal: CallSignal, generation: number) => void;
        }).sendSignal;
        sendSignal.call(facade, { user_id: 'peer-1', device_id: 'peer-device' }, { type: 'candidate', candidate: { candidate: 'candidate' } }, 1);
        expect(sentEvent('group.call.signal')?.payload.generation).toBe(1);
    });

    it('does not send a join for a room with a missing or non-positive generation', async () => {
        const invalidRoom = room('group.call.started', 'active').payload;
        await facade.join({ ...invalidRoom, generation: 0 }, 'self-1');
        await facade.join({ ...invalidRoom, generation: Number.NaN }, 'self-1');
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.join')).toBe(false);
    });

    it('keeps the group call active and exposes sound recovery when autoplay is blocked', async () => {
        await facade.start('group-1', 'self-1');
        const audio = { autoplay: false, muted: true, volume: 0, pause: vi.fn().mockName('pause'), play: vi.fn().mockName('play').mockRejectedValue(new DOMException('blocked', 'NotAllowedError')) } as unknown as HTMLAudioElement;

        facade.playRemoteAudio(audio);
        await flush();

        expect(facade.state.phase).toBe('ringing');
        expect(facade.state.audioPlaybackBlocked).toBe(true);
        expect(facade.state.statusLabel).toBe('Group audio connected. Enable sound to hear the call.');
        audio.play = vi.fn().mockName('play').mockResolvedValue(undefined);
        facade.enableRemoteAudio();
        await flush();

        expect(facade.state.audioPlaybackBlocked).toBe(false);
        expect(vi.mocked(send).mock.calls.some(([event]) => event.type === 'group.call.end')).toBe(false);
    });

    it('applies a selected speaker to every rendered remote peer audio element', async () => {
        const firstPeerAudio = remoteAudio();
        const secondPeerAudio = remoteAudio();

        facade.playRemoteAudio(firstPeerAudio);
        facade.playRemoteAudio(secondPeerAudio);
        await facade.selectOutputDevice('speaker-2');

        expect(firstPeerAudio.setSinkId).toHaveBeenCalledTimes(1);

        expect(firstPeerAudio.setSinkId).toHaveBeenCalledWith('speaker-2');
        expect(secondPeerAudio.setSinkId).toHaveBeenCalledTimes(1);
        expect(secondPeerAudio.setSinkId).toHaveBeenCalledWith('speaker-2');
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
        expect(facade.state.audioPlaybackBlocked).toBe(false);
    });

    function sentEvent(type: string): {
        type: string;
        payload: {
            generation?: number;
        };
    } | undefined {
        return vi.mocked(send).mock.calls.map(([event]) => event as {
            type: string;
            payload: {
                generation?: number;
            };
        }).find(event => event.type === type);
    }
    function sentRequestID(type: string, occurrence = 0): string {
        return vi.mocked(send).mock.calls.map(([event]) => event as {
            type: string;
            request_id: string;
        }).filter(event => event.type === type)[occurrence]?.request_id || '';
    }
    function sentGroupRequest(type: 'group.call.start' | 'group.call.join' | 'group.call.leave' | 'group.call.end', occurrence = 0): string {
        const requests = vi.mocked(send).mock.calls.map(([event]) => event as {
            type: string;
            request_id: string;
        }).filter(event => event.type === type);
        return requests[occurrence]?.request_id ?? '';
    }
    function syncCount(): number { return vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.sync').length; }
    function signalCount(type: CallSignal['type']): number { return vi.mocked(send).mock.calls.filter(([event]) => event.type === 'group.call.signal' && event.payload.signal.type === type).length; }
});

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

function testDisplayTrack(kind: 'video' | 'audio'): {
    track: MediaStreamTrack;
    end: () => void;
} {
    let endedListener: ((event: Event) => void) | undefined;
    const state = {
        kind,
        readyState: 'live' as MediaStreamTrackState,
        stop: vi.fn().mockName('stop'),
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'ended')
                endedListener = typeof listener === 'function' ? listener : event => listener.handleEvent(event);
        },
    };
    state.stop.mockImplementation(() => { state.readyState = 'ended'; });
    return {
        track: state as unknown as MediaStreamTrack,
        end: () => {
            state.readyState = 'ended';
            endedListener?.(new Event('ended'));
        },
    };
}

function testDisplayStream(video: MediaStreamTrack, audio: MediaStreamTrack): MediaStream {
    const tracks = [video, audio];
    return {
        getTracks: () => [...tracks],
        getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
        getAudioTracks: () => tracks.filter(track => track.kind === 'audio'),
        removeTrack: (track: MediaStreamTrack) => { const index = tracks.indexOf(track); if (index >= 0)
            tracks.splice(index, 1); },
    } as unknown as MediaStream;
}

function remoteAudio(): HTMLAudioElement & {
    setSinkId: Mock;
} {
    return {
        autoplay: false,
        muted: true,
        volume: 0,
        pause: vi.fn().mockName('pause'),
        play: vi.fn().mockName('play').mockResolvedValue(undefined),
        setSinkId: vi.fn().mockName('setSinkId').mockResolvedValue(undefined),
    } as unknown as HTMLAudioElement & {
        setSinkId: Mock;
    };
}

function room(type: GroupCallRoomSocketEvent['type'], status: GroupCallRoomPayload['status'], conversationID = 'group-1', generation = 1, stateRevision = type === 'group.call.ended' ? 2 : 1, participants: GroupCallParticipant[] = [{ user_id: 'self-1', device_id: 'device-1' }]): GroupCallRoomSocketEvent & {
    payload: GroupCallRoomEventPayload;
} {
    const payload: GroupCallRoomEventPayload = { room_id: 'room-1', conversation_id: conversationID, membership_revision: 1, generation, state_revision: stateRevision, status, expires_at: '2026-01-01T00:00:00Z', participants, ice_servers: [{ urls: ['turn:turn.example.test:3478'], username: 'opaque', credential: 'opaque' }] };
    return { version: WEBSOCKET_PROTOCOL_VERSION, type, payload };
}

function synced(requestID: string, override: Partial<GroupCallActiveSyncPayload>): GroupCallSyncedSocketEvent {
    const base = room('group.call.started', 'active').payload;
    const { ice_servers: _iceServers, ...snapshot } = base;
    return { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: requestID, payload: { ...snapshot, status: 'active', ...override } };
}

function endedSync(requestID: string): GroupCallSyncedSocketEvent {
    return { version: WEBSOCKET_PROTOCOL_VERSION, type: 'group.call.synced', request_id: requestID, payload: { room_id: 'room-1', generation: 1, status: 'ended' } };
}

function rejected(requestID: string, error: string): MessageSocketEvent {
    return { version: WEBSOCKET_PROTOCOL_VERSION, type: 'call.rejected', request_id: requestID, payload: { error } };
}
