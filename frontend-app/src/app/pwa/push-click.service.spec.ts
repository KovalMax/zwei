import {SwPush} from '@angular/service-worker';
import {Router} from '@angular/router';
import {Subject, of} from 'rxjs';
import {AuthService} from '../auth/auth.service';
import {PushClickService, parsePushClickData} from './push-click.service';

const conversationID = '11111111-1111-4111-8111-111111111111';
const messageID = '22222222-2222-4222-8222-222222222222';

describe('PushClickService', () => {
    it('rejects malformed UUIDs, unknown kinds, and arbitrary navigation fields', () => {
        expect(parsePushClickData({kind: 'message', conversation_id: conversationID, message_id: 'chat/../profile'})).toBeNull();
        expect(parsePushClickData({kind: 'unknown', conversation_id: conversationID})).toBeNull();
        expect(parsePushClickData({kind: 'message', conversation_id: conversationID, message_id: messageID, url: '/profile'})).toBeNull();
    });

    it('parses only the fixed direct-call and group-call payload shapes', () => {
        const callID = '33333333-3333-4333-8333-333333333333';
        expect(parsePushClickData({kind: 'direct_call', conversation_id: conversationID, call_id: callID})).toEqual({kind: 'direct-call', conversationID, callID});
        expect(parsePushClickData({kind: 'group_call', conversation_id: conversationID})).toEqual({kind: 'group-call', conversationID});
    });

    it('accepts and strips only the fixed NGSW default action metadata', () => {
        const data = {kind: 'message', conversation_id: conversationID, message_id: messageID, onActionClick: {default: {operation: 'focusLastFocusedOrOpen', url: '/home'}}};
        expect(parsePushClickData(data)).toEqual({kind: 'message', conversationID, messageID});
        expect(parsePushClickData({kind: 'message', conversation_id: conversationID, message_id: messageID})).toEqual({kind: 'message', conversationID, messageID});
    });

    it('rejects non-fixed NGSW navigation metadata', () => {
        for (const url of ['/profile', 'https://example.com', '//example.com', '/home?next=/profile']) {
            expect(parsePushClickData({kind: 'message', conversation_id: conversationID, message_id: messageID, onActionClick: {default: {operation: 'focusLastFocusedOrOpen', url}}})).toBeNull();
        }
        expect(parsePushClickData({kind: 'message', conversation_id: conversationID, message_id: messageID, onActionClick: {default: {operation: 'openWindow', url: '/home'}}})).toBeNull();
        expect(parsePushClickData({kind: 'message', conversation_id: conversationID, message_id: messageID, onActionClick: {default: {operation: 'focusLastFocusedOrOpen', url: '/home'}, dismiss: {operation: 'openWindow', url: '/profile'}}})).toBeNull();
    });

    it('restores auth once, then navigates only to /home and dispatches validated intent', async () => {
        const clicks = new Subject<{action: string; notification: Notification}>();
        const sw = {isEnabled: true, notificationClicks: clicks};
        const auth = {restore: vi.fn(() => of({token_type: 'Bearer', access_token: 'memory', expires_in: 60}))};
        const router = {navigate: vi.fn().mockResolvedValue(true)};
        const service = new PushClickService(sw as unknown as SwPush, auth as unknown as AuthService, router as unknown as Router);
        const intents: unknown[] = [];
        service.intents.subscribe(intent => intents.push(intent));
        service.start();
        clicks.next({action: '', notification: {data: {kind: 'message', conversation_id: conversationID, message_id: messageID}} as Notification});
        await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledOnce());
        expect(auth.restore).toHaveBeenCalledOnce();
        expect(router.navigate).toHaveBeenCalledWith(['/home']);
        expect(intents).toEqual([{kind: 'message', conversationID, messageID}]);
        service.ngOnDestroy();
    });

    it('dispatches an authenticated intent when /home navigation is ignored as same-URL navigation', async () => {
        const clicks = new Subject<{action: string; notification: Notification}>();
        const router = {url: '/home', navigate: vi.fn().mockResolvedValue(false)};
        const service = new PushClickService(
            {isEnabled: true, notificationClicks: clicks} as unknown as SwPush,
            {restore: () => of({token_type: 'Bearer', access_token: 'memory', expires_in: 60})} as unknown as AuthService,
            router as unknown as Router,
        );
        const intents: unknown[] = [];
        service.intents.subscribe(intent => intents.push(intent));
        service.start();
        clicks.next({action: '', notification: {data: {kind: 'message', conversation_id: conversationID, message_id: messageID}} as Notification});

        await vi.waitFor(() => expect(intents).toEqual([{kind: 'message', conversationID, messageID}]));
        expect(router.navigate).toHaveBeenCalledWith(['/home']);
        service.ngOnDestroy();
    });

    it('suppresses intent when fixed-route navigation fails outside /home', async () => {
        const clicks = new Subject<{action: string; notification: Notification}>();
        const router = {url: '/profile', navigate: vi.fn().mockResolvedValue(false)};
        const service = new PushClickService(
            {isEnabled: true, notificationClicks: clicks} as unknown as SwPush,
            {restore: () => of({token_type: 'Bearer', access_token: 'memory', expires_in: 60})} as unknown as AuthService,
            router as unknown as Router,
        );
        const intents: unknown[] = [];
        service.intents.subscribe(intent => intents.push(intent));
        service.start();
        clicks.next({action: '', notification: {data: {kind: 'message', conversation_id: conversationID, message_id: messageID}} as Notification});

        await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledOnce());
        expect(intents).toEqual([]);
        service.ngOnDestroy();
    });

    it('does not route if auth restoration is anonymous', async () => {
        const clicks = new Subject<{action: string; notification: Notification}>();
        const router = {navigate: vi.fn()};
        const service = new PushClickService(
            {isEnabled: true, notificationClicks: clicks} as unknown as SwPush,
            {restore: () => of(null)} as unknown as AuthService,
            router as unknown as Router,
        );
        service.start();
        clicks.next({action: '', notification: {data: {kind: 'message', conversation_id: conversationID, message_id: messageID}} as Notification});
        await Promise.resolve();
        expect(router.navigate).not.toHaveBeenCalled();
        service.ngOnDestroy();
    });
});
