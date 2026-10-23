import {SwPush} from '@angular/service-worker';
import {Observable, of, throwError} from 'rxjs';
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
