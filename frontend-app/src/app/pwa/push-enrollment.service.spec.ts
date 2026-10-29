import {SwPush} from '@angular/service-worker';
import {Observable, of, Subject, throwError} from 'rxjs';
import {AuthService} from '../auth/auth.service';
import {PushSubscriptionClient} from '../auth/push-subscription.client';
import {PushEnrollmentService} from './push-enrollment.service';

describe('PushEnrollmentService', () => {
    const originalPermission = Object.getOwnPropertyDescriptor(Notification, 'permission');
    let permission: NotificationPermission;
    let sw: {isEnabled: boolean; subscription: Observable<PushSubscription | null>; requestSubscription: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn>};
    let client: {vapidPublicKey: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn>};
    let service: PushEnrollmentService;
    let changes: Subject<void>;
    let auth: {sessionChanges: Observable<void>; sessionIsCurrent: ReturnType<typeof vi.fn>};
    let pushManager: {getSubscription: ReturnType<typeof vi.fn>};
    let newSubscription: PushSubscription;

    beforeEach(() => {
        changes = new Subject<void>();
        auth = {sessionChanges: changes, sessionIsCurrent: vi.fn().mockReturnValue(true)};
        permission = 'granted';
        vi.stubGlobal('Notification', Object.defineProperty({}, 'permission', {get: () => permission}));
        const vapidBytes = Uint8Array.from(atob('B'.repeat(87) + '='), character => character.charCodeAt(0));
        newSubscription = {options: {applicationServerKey: vapidBytes.buffer}, toJSON: () => ({endpoint: 'https://push.example.test/sub', expirationTime: null, keys: {p256dh: 'p256dh', auth: 'auth'}})} as unknown as PushSubscription;
        pushManager = {getSubscription: vi.fn().mockResolvedValue(null)};
        let lock = Promise.resolve();
        const locks = {request: (_name: string, callback: () => Promise<unknown>) => {
            const result = lock.then(callback);
            lock = result.then(() => undefined, () => undefined);
            return result;
        }};
        vi.stubGlobal('navigator', {...navigator, locks, serviceWorker: {ready: Promise.resolve({pushManager})}});
        sw = {isEnabled: true, subscription: of(null as PushSubscription | null), requestSubscription: vi.fn().mockResolvedValue(newSubscription), unsubscribe: vi.fn().mockResolvedValue(true)};
        client = {vapidPublicKey: vi.fn().mockReturnValue(of({public_key: 'B'.repeat(87)})), save: vi.fn().mockReturnValue(of(void 0)), remove: vi.fn().mockReturnValue(of(void 0)), verify: vi.fn().mockReturnValue(of({matches: true}))};
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);
    });

    afterEach(() => {
        service.ngOnDestroy();
        vi.unstubAllGlobals();
        if (originalPermission) Object.defineProperty(Notification, 'permission', originalPermission);
    });

    it('cancels a delayed enrollment on session transition before saving', async () => {
        const pending = new Subject<{public_key: string}>();
        client.vapidPublicKey.mockReturnValueOnce(pending);
        const enrollment = service.enrollFromUserGesture();
        const cancelled = expect(enrollment).rejects.toThrow('push-operation-cancelled');
        changes.next();
        pending.next({public_key: 'B'.repeat(87)});
        await cancelled;
        expect(client.save).not.toHaveBeenCalled();
    });

    it('clears verified state and ignores a delayed verification on session transition', async () => {
        pushManager.getSubscription.mockResolvedValue(newSubscription);
        await service.reconcile();
        expect(service.state).toBe('enabled');
        const pending = new Subject<{matches: boolean}>();
        client.verify.mockReturnValueOnce(pending);
        const reconciliation = service.reconcile();
        await vi.waitFor(() => expect(client.verify).toHaveBeenCalledTimes(2));
        changes.next();
        pending.next({matches: true});
        await reconciliation;
        expect(service.state).not.toBe('enabled');
    });

    it('checks the current binding before a delayed locked save', async () => {
        let resolveLookup!: (value: PushSubscription | null) => void;
        pushManager.getSubscription.mockResolvedValueOnce(null).mockReturnValueOnce(new Promise(resolve => { resolveLookup = resolve; }));
        const enrollment = service.enrollFromUserGesture();
        const cancelled = expect(enrollment).rejects.toThrow('push-operation-cancelled');
        await vi.waitFor(() => expect(pushManager.getSubscription).toHaveBeenCalledTimes(2));
        auth.sessionIsCurrent.mockReturnValue(false);
        resolveLookup(null);
        await cancelled;
        expect(client.save).not.toHaveBeenCalled();
    });

    it('requires granted permission and persists a subscription obtained from the VAPID key', async () => {
        await service.enrollFromUserGesture();
        expect(client.vapidPublicKey).toHaveBeenCalledOnce();
        expect(sw.requestSubscription).toHaveBeenCalledWith({serverPublicKey: 'B'.repeat(87)});
        expect(client.save).toHaveBeenCalledWith({endpoint: 'https://push.example.test/sub', expirationTime: null, keys: {p256dh: 'p256dh', auth: 'auth'}});
        expect(service.state).toBe('enabled');
    });

    it('removes only the account registration and retains the shared browser resource for another tab and reenable', async () => {
        const subscription = {...newSubscription, endpoint: 'https://push.example.test/sub', unsubscribe: vi.fn()} as unknown as PushSubscription;
        pushManager.getSubscription.mockResolvedValue(subscription);
        await service.disable();
        expect(client.remove).toHaveBeenCalledWith();
        expect(subscription.unsubscribe).not.toHaveBeenCalled();
        const otherTab = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);
        await otherTab.enrollFromUserGesture();
        expect(client.save).toHaveBeenCalledOnce();
        await service.enrollFromUserGesture();
        expect(client.save).toHaveBeenCalledTimes(2);
        expect(sw.requestSubscription).not.toHaveBeenCalled();
        otherTab.ngOnDestroy();
    });

    it('waits for an in-flight save before disabling the browser subscription', async () => {
        const pendingSave = new Subject<void>();
        const subscription = {...newSubscription, endpoint: 'https://push.example.test/sub', unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        sw.requestSubscription.mockResolvedValue(subscription);
        client.save.mockReturnValue(pendingSave);
        const enrollment = service.enrollFromUserGesture();
        const cancelled = expect(enrollment).rejects.toThrow('push-operation-cancelled');
        await vi.waitFor(() => expect(client.save).toHaveBeenCalledOnce());
        pushManager.getSubscription.mockResolvedValue(subscription);
        const disable = service.disable();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(client.remove).not.toHaveBeenCalled();
        pendingSave.next();
        pendingSave.complete();
        await cancelled;
        await disable;
        expect(client.remove).toHaveBeenCalledWith();
        expect(service.state).toBe('unverified');
    });

    it('finds the subscription after an in-flight save completes before disabling', async () => {
        const pendingSave = new Subject<void>();
        const subscription = {...newSubscription, endpoint: 'https://push.example.test/sub', unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        client.save.mockReturnValueOnce(pendingSave);
        sw.requestSubscription.mockResolvedValueOnce(subscription);
        const enrollment = service.enrollFromUserGesture();
        const cancelled = expect(enrollment).rejects.toThrow('push-operation-cancelled');
        await vi.waitFor(() => expect(client.save).toHaveBeenCalledOnce());
        const disable = service.disable();
        await new Promise(resolve => setTimeout(resolve, 0));
        pushManager.getSubscription.mockResolvedValue(subscription);
        pendingSave.next();
        pendingSave.complete();
        await cancelled;
        await disable;
        expect(client.remove).toHaveBeenCalledWith();
        expect(subscription.unsubscribe).not.toHaveBeenCalled();
    });

    it('waits for a disabling server removal before saving a newer enrollment', async () => {
        const pendingRemove = new Subject<void>();
        const subscription = {...newSubscription, endpoint: 'https://push.example.test/sub', unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        pushManager.getSubscription.mockResolvedValue(subscription);
        client.remove.mockReturnValueOnce(pendingRemove);
        const disable = service.disable();
        const cancelled = expect(disable).rejects.toThrow('push-operation-cancelled');
        await vi.waitFor(() => expect(client.remove).toHaveBeenCalledOnce());
        const enrollment = service.enrollFromUserGesture();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(client.save).not.toHaveBeenCalled();
        pendingRemove.next();
        pendingRemove.complete();
        await cancelled;
        await enrollment;
        expect(service.state).toBe('enabled');
    });

    it('does not reuse or retain a timed-out browser subscription that resolves after logout', async () => {
        vi.useFakeTimers();
        let resolveRequest!: (subscription: PushSubscription) => void;
        const lateSubscription = {...newSubscription, unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        sw.requestSubscription.mockReturnValueOnce(new Promise<PushSubscription>(resolve => { resolveRequest = resolve; }));

        const enrollment = service.enrollFromUserGesture();
        const timedOut = expect(enrollment).rejects.toThrow('push-service-timeout');
        await vi.waitFor(() => expect(sw.requestSubscription).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(25_000);
        await timedOut;
        expect(client.save).not.toHaveBeenCalled();

        await service.unsubscribeLocal();
        resolveRequest(lateSubscription);
        await Promise.resolve();
        await Promise.resolve();
        expect(lateSubscription.unsubscribe).not.toHaveBeenCalled();
        expect(sw.unsubscribe).not.toHaveBeenCalled();

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

    it('preserves a shared browser subscription when logout wins while saving it', async () => {
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
        expect(subscription.unsubscribe).not.toHaveBeenCalled();
        expect(sw.unsubscribe).not.toHaveBeenCalled();
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
        const newerEnrollment = service.enrollFromUserGesture();
        pendingSave.next();
        pendingSave.complete();
        await expect(olderEnrollment).rejects.toThrow('push-operation-cancelled');
        await newerEnrollment;

        expect(subscription.unsubscribe).not.toHaveBeenCalled();
        expect(service.state).toBe('enabled');
    });

    it('clears local enrollment on logout after ignoring a delayed initial null subscription', async () => {
        service.ngOnDestroy();
        const subscriptionChanges = new Subject<PushSubscription | null>();
        sw.subscription = subscriptionChanges.asObservable();
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);

        await service.enrollFromUserGesture();
        subscriptionChanges.next(null);

        expect(service.state).toBe('enabled');

        await service.unsubscribeLocal();

        expect(service.state).toBe('not-enrolled');
        expect(sw.unsubscribe).not.toHaveBeenCalled();
    });

    it('keeps a re-enrollment enabled when the initial null subscription arrives after logout', async () => {
        service.ngOnDestroy();
        const subscriptionChanges = new Subject<PushSubscription | null>();
        sw.subscription = subscriptionChanges.asObservable();
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);

        await service.enrollFromUserGesture();
        await service.unsubscribeLocal();
        expect(service.state).toBe('not-enrolled');

        await service.enrollFromUserGesture();
        subscriptionChanges.next(null);

        expect(service.state).toBe('enabled');
    });

    it('resets local enrollment when a concurrent failed enrollment follows logout', async () => {
        await service.enrollFromUserGesture();
        const logout = service.unsubscribeLocal();

        client.vapidPublicKey.mockImplementationOnce(() => { throw new Error('VAPID key unavailable'); });
        await expect(service.enrollFromUserGesture()).rejects.toThrow('VAPID key unavailable');

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
        expect(service.state).toBe('unverified');
    });

    it('reports an existing browser subscription as unverified rather than disabled or enabled', () => {
        service.ngOnDestroy();
        sw.subscription = of(newSubscription);
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);
        expect(service.state).toBe('unverified');
    });

    it('reconciles a matching existing subscription without prompting or saving', async () => {
        pushManager.getSubscription.mockResolvedValue(newSubscription);
        await service.reconcile();
        expect(client.verify).toHaveBeenCalledWith({endpoint: 'https://push.example.test/sub', expirationTime: null, keys: {p256dh: 'p256dh', auth: 'auth'}});
        expect(service.state).toBe('enabled');
        expect(client.save).not.toHaveBeenCalled();
        expect(sw.requestSubscription).not.toHaveBeenCalled();
    });

    it('clears verified state when reconciliation finds the browser subscription removed', async () => {
        service.ngOnDestroy();
        const changes = new Subject<PushSubscription | null>();
        sw.subscription = changes.asObservable();
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);
        changes.next(newSubscription);
        pushManager.getSubscription.mockResolvedValueOnce(newSubscription).mockResolvedValueOnce(null);
        await service.reconcile();
        expect(service.state).toBe('enabled');
        await service.reconcile();
        expect(service.state).toBe('not-enrolled');
        changes.next(newSubscription);
        expect(service.state).toBe('unverified');
    });

    it('ignores a stale null reconciliation after a newer enrollment', async () => {
        let resolveLookup!: (subscription: PushSubscription | null) => void;
        pushManager.getSubscription.mockReturnValueOnce(new Promise(resolve => { resolveLookup = resolve; }));
        const reconciliation = service.reconcile();
        await vi.waitFor(() => expect(pushManager.getSubscription).toHaveBeenCalledOnce());
        await service.enrollFromUserGesture();
        resolveLookup(null);
        await reconciliation;
        expect(service.state).toBe('enabled');
    });

    it('reconciles when the initial subscription arrives while the worker is becoming ready', async () => {
        service.ngOnDestroy();
        const changes = new Subject<PushSubscription | null>();
        sw.subscription = changes.asObservable();
        let ready!: (registration: {pushManager: typeof pushManager}) => void;
        vi.stubGlobal('navigator', {...navigator, serviceWorker: {ready: new Promise(resolve => { ready = resolve; })}});
        pushManager.getSubscription.mockResolvedValue(newSubscription);
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);
        const reconciliation = service.reconcile();
        changes.next(newSubscription);
        ready({pushManager});
        await reconciliation;
        expect(service.state).toBe('enabled');
        expect(client.verify).toHaveBeenCalledOnce();
    });

    it('marks a replacement browser subscription unverified', async () => {
        service.ngOnDestroy();
        const changes = new Subject<PushSubscription | null>();
        sw.subscription = changes.asObservable();
        service = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);
        changes.next(newSubscription);
        pushManager.getSubscription.mockResolvedValue(newSubscription);
        await service.reconcile();
        expect(service.state).toBe('enabled');
        changes.next({...newSubscription, toJSON: () => ({endpoint: 'https://push.example.test/replacement', keys: {p256dh: 'other', auth: 'other'}})} as PushSubscription);
        expect(service.state).toBe('unverified');
    });

    it('leaves mismatches and verification errors unverified and allows disable', async () => {
        const subscription = {...newSubscription, endpoint: 'https://push.example.test/sub', unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        pushManager.getSubscription.mockResolvedValue(subscription);
        client.verify.mockReturnValueOnce(of({matches: false})).mockReturnValueOnce(throwError(() => new Error('offline')));
        await service.reconcile();
        expect(service.state).toBe('unverified');
        await service.reconcile();
        expect(service.state).toBe('unverified');
        await service.disable();
        expect(client.remove).toHaveBeenCalledWith();
        expect(service.state).toBe('unverified');
    });

    it('deletes the current registration even when no browser subscription exists', async () => {
        await service.disable();
        expect(client.remove).toHaveBeenCalledWith();
        expect(sw.unsubscribe).not.toHaveBeenCalled();
    });

    it('keeps a failed deletion unconfirmed and permits retry without a browser endpoint', async () => {
        client.remove.mockReturnValueOnce(throwError(() => new Error('offline')));
        await expect(service.disable()).rejects.toThrow('offline');
        expect(service.state).toBe('unverified');
        await service.disable();
        expect(service.state).toBe('not-enrolled');
        expect(client.remove).toHaveBeenCalledTimes(2);
    });

    it('does not save a subscription replaced before the locked write', async () => {
        const changed = {...newSubscription, toJSON: () => ({endpoint: 'https://push.example.test/other', keys: {p256dh: 'p256dh', auth: 'auth'}})} as PushSubscription;
        pushManager.getSubscription.mockResolvedValueOnce(null).mockResolvedValueOnce(changed);
        await expect(service.enrollFromUserGesture()).rejects.toThrow('push-subscription-changed');
        expect(client.save).not.toHaveBeenCalled();
        expect(service.state).toBe('unverified');
    });

    it('serializes a save in one tab before a delete in another tab', async () => {
        const pending = new Subject<void>();
        client.save.mockReturnValueOnce(pending);
        const other = new PushEnrollmentService(sw as unknown as SwPush, client as unknown as PushSubscriptionClient, auth as unknown as AuthService);
        const save = service.enrollFromUserGesture();
        await vi.waitFor(() => expect(client.save).toHaveBeenCalledOnce());
        const disable = other.disable();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(client.remove).not.toHaveBeenCalled();
        pending.next(); pending.complete();
        await save;
        await disable;
        expect(client.remove).toHaveBeenCalledOnce();
        other.ngOnDestroy();
    });

    it('does not verify a subscription with a rotated VAPID key', async () => {
        pushManager.getSubscription.mockResolvedValue({...newSubscription, options: {applicationServerKey: new Uint8Array(65).fill(2).buffer}});
        await service.reconcile();
        expect(service.state).toBe('unverified');
        expect(client.verify).not.toHaveBeenCalled();
    });

    it('ignores verification responses after disabling', async () => {
        const pending = new Subject<{matches: boolean}>();
        const subscription = {...newSubscription, endpoint: 'https://push.example.test/sub', unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        pushManager.getSubscription.mockResolvedValue(subscription);
        client.verify.mockReturnValue(pending);
        const reconciliation = service.reconcile();
        await vi.waitFor(() => expect(client.verify).toHaveBeenCalledOnce());
        await service.disable();
        pending.next({matches: true});
        await reconciliation;
        expect(service.state).toBe('unverified');
    });

    it('preserves a late subscription after disable and reuses it on reenable', async () => {
        let resolveRequest!: (subscription: PushSubscription) => void;
        const late = {...newSubscription, unsubscribe: vi.fn()} as unknown as PushSubscription;
        sw.requestSubscription.mockReturnValueOnce(new Promise<PushSubscription>(resolve => { resolveRequest = resolve; }));
        const enrollment = service.enrollFromUserGesture();
        const cancelled = expect(enrollment).rejects.toThrow('push-operation-cancelled');
        await vi.waitFor(() => expect(sw.requestSubscription).toHaveBeenCalledOnce());
        await service.disable();
        resolveRequest(late);
        await cancelled;
        expect(late.unsubscribe).not.toHaveBeenCalled();
        expect(client.save).not.toHaveBeenCalled();
        await service.enrollFromUserGesture();
        expect(client.save).toHaveBeenCalledOnce();
        expect(sw.requestSubscription).toHaveBeenCalledOnce();
    });

    it('does not clean an older pending subscription after a newer enrollment wins', async () => {
        let resolveRequest!: (subscription: PushSubscription) => void;
        const late = {...newSubscription, unsubscribe: vi.fn().mockResolvedValue(true)} as unknown as PushSubscription;
        sw.requestSubscription.mockReturnValueOnce(new Promise<PushSubscription>(resolve => { resolveRequest = resolve; }));
        const older = service.enrollFromUserGesture();
        const cancelled = expect(older).rejects.toThrow('push-operation-cancelled');
        await vi.waitFor(() => expect(sw.requestSubscription).toHaveBeenCalledOnce());
        await service.disable();
        await service.disable();
        await service.enrollFromUserGesture();
        resolveRequest(late);
        await cancelled;
        expect(late.unsubscribe).not.toHaveBeenCalled();
        expect(service.state).toBe('enabled');
    });

    it('does not replace a shared subscription when the VAPID key differs', async () => {
        const old = {options: {applicationServerKey: new Uint8Array(65).fill(2).buffer}, unsubscribe: vi.fn()} as unknown as PushSubscription;
        pushManager.getSubscription.mockResolvedValue(old);
        await expect(service.enrollFromUserGesture()).rejects.toThrow('subscription-key-mismatch');
        expect(old.unsubscribe).not.toHaveBeenCalled();
        expect(sw.requestSubscription).not.toHaveBeenCalled();
        expect(client.save).not.toHaveBeenCalled();
    });
});
