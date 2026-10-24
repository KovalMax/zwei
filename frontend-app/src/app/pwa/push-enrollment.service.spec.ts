import {SwPush} from '@angular/service-worker';
import {Observable, of, Subject, throwError} from 'rxjs';
import {PushSubscriptionClient} from '../auth/push-subscription.client';
import {PushEnrollmentService} from './push-enrollment.service';

describe('PushEnrollmentService', () => {
    const originalPermission = Object.getOwnPropertyDescriptor(Notification, 'permission');
    let permission: NotificationPermission;
    let sw: {isEnabled: boolean; subscription: Observable<PushSubscription | null>; requestSubscription: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn>};
    let client: {vapidPublicKey: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>};
    let service: PushEnrollmentService;
    let pushManager: {getSubscription: ReturnType<typeof vi.fn>};
    let newSubscription: PushSubscription;

    beforeEach(() => {
        permission = 'granted';
        vi.stubGlobal('Notification', Object.defineProperty({}, 'permission', {get: () => permission}));
        const vapidBytes = Uint8Array.from(atob('B'.repeat(87) + '='), character => character.charCodeAt(0));
        newSubscription = {options: {applicationServerKey: vapidBytes.buffer}, toJSON: () => ({endpoint: 'https://push.example.test/sub', expirationTime: null, keys: {p256dh: 'p256dh', auth: 'auth'}})} as unknown as PushSubscription;
        pushManager = {getSubscription: vi.fn().mockResolvedValue(null)};
        vi.stubGlobal('navigator', {...navigator, serviceWorker: {ready: Promise.resolve({pushManager})}});
        sw = {isEnabled: true, subscription: of(null as PushSubscription | null), requestSubscription: vi.fn().mockResolvedValue(newSubscription), unsubscribe: vi.fn().mockResolvedValue(true)};
        client = {vapidPublicKey: vi.fn().mockReturnValue(of({public_key: 'B'.repeat(87)})), save: vi.fn().mockReturnValue(of(void 0))};
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient);
    });

    afterEach(() => {
        service.ngOnDestroy();
        vi.unstubAllGlobals();
        if (originalPermission) Object.defineProperty(Notification, 'permission', originalPermission);
    });

    it('requires granted permission and persists a subscription obtained from the VAPID key', async () => {
        await service.enrollFromUserGesture();
        expect(client.vapidPublicKey).toHaveBeenCalledOnce();
        expect(sw.requestSubscription).toHaveBeenCalledWith({serverPublicKey: 'B'.repeat(87)});
        expect(client.save).toHaveBeenCalledWith({endpoint: 'https://push.example.test/sub', expirationTime: null, keys: {p256dh: 'p256dh', auth: 'auth'}});
        expect(service.state).toBe('enabled');
    });

    it('does not reuse or retain a timed-out browser subscription that resolves after logout', async () => {
        vi.useFakeTimers();
        let resolveRequest!: (subscription: PushSubscription) => void;
        const lateSubscription = {...newSubscription, unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        sw.requestSubscription.mockReturnValueOnce(new Promise<PushSubscription>(resolve => { resolveRequest = resolve; }));

        const enrollment = service.enrollFromUserGesture();
        await vi.waitFor(() => expect(sw.requestSubscription).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(25_000);
        await expect(enrollment).rejects.toThrow('push-service-timeout');
        expect(client.save).not.toHaveBeenCalled();

        await service.unsubscribeLocal();
        resolveRequest(lateSubscription);
        await Promise.resolve();
        await Promise.resolve();
        expect(lateSubscription.unsubscribe).toHaveBeenCalledOnce();

        await service.enrollFromUserGesture();
        expect(sw.requestSubscription).toHaveBeenCalledTimes(2);
        expect(client.save).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it('does not create or save a subscription when logout wins during the VAPID-key request', async () => {
        const pendingKey = new Subject<{public_key: string}>();
        client.vapidPublicKey.mockReturnValueOnce(pendingKey);

        const enrollment = service.enrollFromUserGesture();
        await vi.waitFor(() => expect(client.vapidPublicKey).toHaveBeenCalledOnce());
        await service.unsubscribeLocal();
        pendingKey.next({public_key: 'B'.repeat(87)});
        pendingKey.complete();

        await expect(enrollment).rejects.toThrow('push-operation-cancelled');
        expect(sw.requestSubscription).not.toHaveBeenCalled();
        expect(client.save).not.toHaveBeenCalled();
        expect(service.state).toBe('not-enrolled');
    });

    it('cleans up a browser subscription when logout wins while saving it', async () => {
        const pendingSave = new Subject<void>();
        const subscription = {...newSubscription, unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        sw.requestSubscription.mockResolvedValueOnce(subscription);
        client.save.mockReturnValueOnce(pendingSave);

        const enrollment = service.enrollFromUserGesture();
        await vi.waitFor(() => expect(client.save).toHaveBeenCalledOnce());
        await service.unsubscribeLocal();
        pendingSave.next();
        pendingSave.complete();

        await expect(enrollment).rejects.toThrow('push-operation-cancelled');
        expect(subscription.unsubscribe).toHaveBeenCalledOnce();
        expect(service.state).toBe('not-enrolled');
    });

    it('does not unsubscribe a subscription reused by a newer enrollment when an older save resolves late', async () => {
        const pendingSave = new Subject<void>();
        const subscription = {...newSubscription, unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        sw.requestSubscription.mockResolvedValueOnce(subscription);
        pushManager.getSubscription
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(subscription)
            .mockResolvedValueOnce(subscription);
        client.save.mockReturnValueOnce(pendingSave).mockReturnValueOnce(of(void 0));

        const olderEnrollment = service.enrollFromUserGesture();
        await vi.waitFor(() => expect(client.save).toHaveBeenCalledOnce());
        await service.enrollFromUserGesture();
        expect(service.state).toBe('enabled');

        pendingSave.next();
        pendingSave.complete();
        await expect(olderEnrollment).rejects.toThrow('push-operation-cancelled');

        expect(subscription.unsubscribe).not.toHaveBeenCalled();
        expect(service.state).toBe('enabled');
    });

    it('clears local enrollment on logout after ignoring a delayed initial null subscription', async () => {
        service.ngOnDestroy();
        const subscriptionChanges = new Subject<PushSubscription | null>();
        sw.subscription = subscriptionChanges.asObservable();
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient);

        await service.enrollFromUserGesture();
        subscriptionChanges.next(null);

        expect(service.state).toBe('enabled');

        sw.unsubscribe.mockRejectedValueOnce(new Error('local unsubscribe failed'));
        await service.unsubscribeLocal();

        expect(service.state).toBe('not-enrolled');
        expect(sw.unsubscribe).toHaveBeenCalledOnce();
    });

    it('keeps a re-enrollment enabled when the initial null subscription arrives after logout', async () => {
        service.ngOnDestroy();
        const subscriptionChanges = new Subject<PushSubscription | null>();
        sw.subscription = subscriptionChanges.asObservable();
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient);

        await service.enrollFromUserGesture();
        await service.unsubscribeLocal();
        expect(service.state).toBe('not-enrolled');

        await service.enrollFromUserGesture();
        subscriptionChanges.next(null);

        expect(service.state).toBe('enabled');
    });

    it('keeps enrollment enabled when a pending logout unsubscribe completes after enrollment', async () => {
        let finishUnsubscribe!: (result: boolean) => void;
        sw.unsubscribe.mockReturnValueOnce(new Promise<boolean>(resolve => { finishUnsubscribe = resolve; }));

        const logout = service.unsubscribeLocal();
        await service.enrollFromUserGesture();
        finishUnsubscribe(true);
        await logout;

        expect(service.state).toBe('enabled');
    });

    it('resets local enrollment when a concurrent failed enrollment follows logout', async () => {
        await service.enrollFromUserGesture();

        let finishUnsubscribe!: (result: boolean) => void;
        sw.unsubscribe.mockReturnValueOnce(new Promise<boolean>(resolve => { finishUnsubscribe = resolve; }));
        const logout = service.unsubscribeLocal();

        client.vapidPublicKey.mockImplementationOnce(() => { throw new Error('VAPID key unavailable'); });
        await expect(service.enrollFromUserGesture()).rejects.toThrow('VAPID key unavailable');

        finishUnsubscribe(true);
        await logout;

        expect(service.state).toBe('not-enrolled');
    });

    it('does not request a subscription when permission is denied', async () => {
        permission = 'denied';
        await expect(service.enrollFromUserGesture()).rejects.toThrow('denied');
        expect(sw.requestSubscription).not.toHaveBeenCalled();
    });

    it('reports unsupported service workers and does not call the API', async () => {
        sw.isEnabled = false;
        expect(service.state).toBe('unsupported');
        await expect(service.enrollFromUserGesture()).rejects.toThrow('unsupported');
        expect(client.vapidPublicKey).not.toHaveBeenCalled();
    });

    it('surfaces subscription persistence failures for the Profile retry state', async () => {
        client.save.mockReturnValue(throwError(() => new Error('offline')));
        await expect(service.enrollFromUserGesture()).rejects.toThrow('offline');
    });

    it('removes a subscription using a rotated VAPID key before requesting and persisting its replacement', async () => {
        const old = {options: {applicationServerKey: new Uint8Array(65).fill(2).buffer}, unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        pushManager.getSubscription.mockResolvedValueOnce(old).mockResolvedValueOnce(null);
        await service.enrollFromUserGesture();
        expect(old.unsubscribe).toHaveBeenCalledOnce();
        expect(sw.requestSubscription).toHaveBeenCalledOnce();
        expect(client.save).toHaveBeenCalledOnce();
    });
});
