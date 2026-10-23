import {Injectable, OnDestroy} from '@angular/core';
import {SwPush} from '@angular/service-worker';
import {firstValueFrom} from 'rxjs';
import {Subscription} from 'rxjs';
import {PushSubscriptionClient} from '../auth/push-subscription.client';

export type PushEnrollmentState = 'unsupported' | 'denied' | 'permission-required' | 'not-enrolled' | 'enabled';

@Injectable({providedIn: 'root'})
export class PushEnrollmentService implements OnDestroy {
    private enrolled = false;
    private readonly subscription: Subscription;
    constructor(private readonly swPush: SwPush, private readonly client: PushSubscriptionClient) {
        this.subscription = this.swPush.subscription.subscribe(value => { this.enrolled = value !== null; });
    }
    public ngOnDestroy(): void { this.subscription.unsubscribe(); }

    public get state(): PushEnrollmentState {
        if (!this.swPush.isEnabled || typeof Notification === 'undefined') return 'unsupported';
        if (Notification.permission === 'denied') return 'denied';
        if (Notification.permission !== 'granted') return 'permission-required';
        return this.enrolled ? 'enabled' : 'not-enrolled';
    }

    /** Call directly from an explicit user gesture: browser permission is transient activation gated. */
    public async enrollFromUserGesture(): Promise<void> {
        if (!this.swPush.isEnabled || typeof Notification === 'undefined') throw new Error('unsupported');
        let permission = Notification.permission;
        if (permission === 'default') permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'permission-required');
        const {public_key: publicKey} = await firstValueFrom(this.client.vapidPublicKey());
        const validKey = validateVapidKey(publicKey);
        const applicationServerKey = decodeVapidKey(validKey);
        const registration = await navigator.serviceWorker.ready;
        const current = await registration.pushManager.getSubscription();
        if (current && !sameBytes(current.options.applicationServerKey, applicationServerKey)) {
            await current.unsubscribe();
        }
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription || !sameBytes(subscription.options.applicationServerKey, applicationServerKey)) {
            if (subscription) await subscription.unsubscribe();
            subscription = await this.swPush.requestSubscription({serverPublicKey: validKey});
        }
        if (!sameBytes(subscription.options.applicationServerKey, applicationServerKey)) throw new Error('subscription-key-mismatch');
        const wire = subscription.toJSON();
        const endpoint = wire.endpoint;
        const p256dh = wire.keys?.['p256dh'];
        const auth = wire.keys?.['auth'];
        if (!endpoint || !p256dh || !auth) throw new Error('invalid-subscription');
        await firstValueFrom(this.client.save({endpoint, expirationTime: wire.expirationTime ?? null, keys: {p256dh, auth}}));
        this.enrolled = true;
    }

    /** Server logout revokes every subscription; this is best-effort local cleanup only. */
    public async unsubscribeLocal(): Promise<void> {
        try { await this.swPush.unsubscribe(); } catch { /* The server revocation is authoritative. */ }
    }
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
