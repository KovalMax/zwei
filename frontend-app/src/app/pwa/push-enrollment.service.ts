import {Injectable, OnDestroy} from '@angular/core';
import {SwPush} from '@angular/service-worker';
import {firstValueFrom} from 'rxjs';
import {Subscription} from 'rxjs';
import {PushSubscriptionClient} from '../auth/push-subscription.client';
import {AuthService} from '../auth/auth.service';

export type PushEnrollmentState = 'unsupported' | 'denied' | 'permission-required' | 'not-enrolled' | 'unverified' | 'enabled';
const SUBSCRIPTION_REQUEST_TIMEOUT_MS = 25_000;

@Injectable({providedIn: 'root'})
export class PushEnrollmentService implements OnDestroy {
    private enrolled = false;
    private unconfirmed = false;
    private verifiedSubscription?: string;
    private browserSubscriptionPresent = false;
    private readonly pendingSaves = new Set<Promise<void>>();
    private operationVersion = 0;
    private subscriptionVersion = 0;
    private reconciliationVersion = 0;
    private logoutGeneration = 0;
    private lastDisableVersion = 0;
    private initialSubscriptionResolved = false;
    private lateSubscription?: PushSubscription;
    private localCleanup?: Promise<void>;
    private readonly subscription = new Subscription();
    constructor(private readonly swPush: SwPush, private readonly client: PushSubscriptionClient, private readonly auth: AuthService) {
        this.subscription.add(this.swPush.subscription.subscribe(value => {
            const staleInitialNull = !this.initialSubscriptionResolved && value === null && this.enrolled;
            this.initialSubscriptionResolved = true;
            if (!staleInitialNull) this.subscriptionVersion++;
            if (!staleInitialNull) this.browserSubscriptionPresent = value !== null;
            // A browser subscription alone does not prove server enrollment.
            if (!staleInitialNull && (!value || subscriptionIdentity(value) !== this.verifiedSubscription)) this.enrolled = false;
        }));
        this.subscription.add(this.auth.sessionChanges.subscribe(() => { void this.unsubscribeLocal(); }));
    }
    public ngOnDestroy(): void { this.operationVersion++; this.subscription.unsubscribe(); }

    public get state(): PushEnrollmentState {
        if (this.enrolled) this.auth.sessionIsCurrent();
        if (!this.swPush.isEnabled || typeof Notification === 'undefined') return 'unsupported';
        if (Notification.permission === 'denied') return 'denied';
        if (Notification.permission !== 'granted') return 'permission-required';
        return this.enrolled ? 'enabled' : this.browserSubscriptionPresent || this.unconfirmed ? 'unverified' : 'not-enrolled';
    }

    /** Read-only recovery for an authenticated profile; never prompts or writes a subscription. */
    public async reconcile(): Promise<void> {
        const reconciliationVersion = ++this.reconciliationVersion;
        if (!this.swPush.isEnabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const operationVersion = this.operationVersion;
        const operationCurrent = () => operationVersion === this.operationVersion && reconciliationVersion === this.reconciliationVersion && this.auth.sessionIsCurrent();
        try {
            const registration = await navigator.serviceWorker.ready;
            if (!operationCurrent()) return;
            const subscriptionVersion = this.subscriptionVersion;
            const current = () => operationCurrent() && subscriptionVersion === this.subscriptionVersion;
            const subscription = await registration.pushManager.getSubscription();
            if (!current()) return;
            if (!subscription) {
                this.enrolled = false;
                this.verifiedSubscription = undefined;
                this.browserSubscriptionPresent = false;
                return;
            }
            this.browserSubscriptionPresent = true;
            this.enrolled = false;
            const {public_key: publicKey} = await firstValueFrom(this.client.vapidPublicKey());
            if (!current() || !sameBytes(subscription.options.applicationServerKey, decodeVapidKey(validateVapidKey(publicKey)))) return;
            const wire = subscription.toJSON();
            const endpoint = wire.endpoint;
            const p256dh = wire.keys?.['p256dh'];
            const auth = wire.keys?.['auth'];
            if (!endpoint || !p256dh || !auth) return;
            const result = await firstValueFrom(this.client.verify({endpoint, expirationTime: wire.expirationTime ?? null, keys: {p256dh, auth}}));
            if (current()) {
                this.enrolled = result.matches === true;
                this.verifiedSubscription = this.enrolled ? subscriptionIdentity(subscription) : undefined;
            }
        } catch {
            // A failed verification is not proof of server enrollment.
        }
    }

    /** Call directly from an explicit user gesture: browser permission is transient activation gated. */
    public async enrollFromUserGesture(): Promise<void> {
        const operationVersion = ++this.operationVersion;
        const logoutGeneration = this.logoutGeneration;
        if (!this.swPush.isEnabled || typeof Notification === 'undefined') throw new Error('unsupported');
        let permission = Notification.permission;
        if (permission === 'default') {
            permission = await Notification.requestPermission();
            this.assertCurrentOperation(operationVersion);
        }
        if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'permission-required');
        const {public_key: publicKey} = await firstValueFrom(this.client.vapidPublicKey());
        this.assertCurrentOperation(operationVersion);
        await this.localCleanup;
        this.assertCurrentOperation(operationVersion);
        const validKey = validateVapidKey(publicKey);
        const applicationServerKey = decodeVapidKey(validKey);
        const registration = await navigator.serviceWorker.ready;
        this.assertCurrentOperation(operationVersion);
        const current = await registration.pushManager.getSubscription();
        this.assertCurrentOperation(operationVersion);
        if (current && !sameBytes(current.options.applicationServerKey, applicationServerKey)) throw new Error('subscription-key-mismatch');
        let subscription = current;
        if (!subscription && this.lateSubscription && sameBytes(this.lateSubscription.options.applicationServerKey, applicationServerKey)) {
            subscription = this.lateSubscription;
        }
        if (!subscription) subscription = await this.requestSubscription(validKey, operationVersion, logoutGeneration);
        this.assertCurrentOperation(operationVersion);
        if (!sameBytes(subscription.options.applicationServerKey, applicationServerKey)) throw new Error('subscription-key-mismatch');
        const wire = subscription.toJSON();
        const endpoint = wire.endpoint;
        const p256dh = wire.keys?.['p256dh'];
        const auth = wire.keys?.['auth'];
        if (!endpoint || !p256dh || !auth) throw new Error('invalid-subscription');
        this.browserSubscriptionPresent = true;
        this.enrolled = false;
        this.unconfirmed = true;
        await this.withPushLock(async () => {
            this.assertCurrentOperation(operationVersion);
            const latest = await registration.pushManager.getSubscription();
            this.assertCurrentOperation(operationVersion);
            if (latest && subscriptionIdentity(latest) !== subscriptionIdentity(subscription)) throw new Error('push-subscription-changed');
            const save = firstValueFrom(this.client.save({endpoint, expirationTime: wire.expirationTime ?? null, keys: {p256dh, auth}}));
            this.pendingSaves.add(save);
            try { await save; } finally { this.pendingSaves.delete(save); }
        });
        this.assertCurrentOperation(operationVersion);
        this.enrolled = true;
        this.unconfirmed = false;
        this.verifiedSubscription = subscriptionIdentity(subscription);
        this.lateSubscription = undefined;
    }

    /** Forget this account's state; the browser subscription is shared across tabs. */
    public async unsubscribeLocal(): Promise<void> {
        ++this.operationVersion;
        this.logoutGeneration++;
        this.lateSubscription = undefined;
        this.enrolled = false;
        this.unconfirmed = false;
        this.verifiedSubscription = undefined;
        this.browserSubscriptionPresent = false;
    }

    /** Remove only this account/device registration; the browser subscription is shared. */
    public async disable(): Promise<void> {
        const operationVersion = ++this.operationVersion;
        this.lastDisableVersion = operationVersion;
        const previous = this.localCleanup;
        const disable = (async () => {
            await previous;
            await this.disableSubscription(operationVersion, this.lateSubscription);
        })();
        const barrier = disable.catch(() => undefined);
        this.localCleanup = barrier;
        try { await disable; } finally {
            if (this.localCleanup === barrier) this.localCleanup = undefined;
        }
    }

    private async disableSubscription(operationVersion: number, late?: PushSubscription): Promise<void> {
        await Promise.all([...this.pendingSaves].map(save => save.catch(() => undefined)));
        this.assertCurrentOperation(operationVersion);
        this.enrolled = false;
        this.unconfirmed = true;
        this.verifiedSubscription = undefined;
        await this.withPushLock(async () => {
            this.assertCurrentOperation(operationVersion);
            await firstValueFrom(this.client.remove());
        });
        this.assertCurrentOperation(operationVersion);
        this.unconfirmed = false;
        this.browserSubscriptionPresent = this.browserSubscriptionPresent || !!late;
    }

    private async withPushLock<T>(operation: () => Promise<T>): Promise<T> {
        if (!navigator.locks) throw new Error('push-lock-unavailable');
        return navigator.locks.request('zwei-push-subscription', operation);
    }

    private requestSubscription(serverPublicKey: string, operationVersion: number, logoutGeneration: number): Promise<PushSubscription> {
        const request = this.swPush.requestSubscription({serverPublicKey});
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('push-service-timeout')), SUBSCRIPTION_REQUEST_TIMEOUT_MS);
            request.then(subscription => {
                clearTimeout(timer);
                if (operationVersion !== this.operationVersion) {
                    if (logoutGeneration === this.logoutGeneration && (this.lastDisableVersion <= operationVersion || this.operationVersion === this.lastDisableVersion)) {
                        this.lateSubscription = subscription;
                        this.browserSubscriptionPresent = true;
                    }
                    reject(new Error('push-operation-cancelled'));
                    return;
                }
                this.lateSubscription = subscription;
                resolve(subscription);
            }, error => {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    private assertCurrentOperation(operationVersion: number): void {
        if (operationVersion !== this.operationVersion || !this.auth.sessionIsCurrent()) throw new Error('push-operation-cancelled');
    }

}

function subscriptionIdentity(subscription: PushSubscription): string {
    const wire = subscription.toJSON();
    return JSON.stringify([wire.endpoint, wire.expirationTime ?? null, wire.keys?.['p256dh'], wire.keys?.['auth']]);
}

function validateVapidKey(value: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid-vapid-key');
    if (decodeVapidKey(value).byteLength !== 65) throw new Error('invalid-vapid-key');
    return value;
}

function decodeVapidKey(value: string): Uint8Array {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function sameBytes(current: ArrayBuffer | null, expected: Uint8Array): boolean {
    if (!current) return false;
    const bytes = new Uint8Array(current);
    return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
}
