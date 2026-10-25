import {Injectable, OnDestroy} from '@angular/core';
import {SwPush} from '@angular/service-worker';
import {Router} from '@angular/router';
import {Subject, Subscription, catchError, firstValueFrom, of} from 'rxjs';
import {AuthService} from '../auth/auth.service';

export type PushClickIntent =
    | {kind: 'message'; conversationID: string; messageID: string}
    | {kind: 'direct-call'; callID: string; conversationID: string}
    | {kind: 'group-call'; conversationID: string};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NGSW_ACTION_CLICK = {operation: 'focusLastFocusedOrOpen', url: '/home'} as const;

@Injectable({providedIn: 'root'})
export class PushClickService implements OnDestroy {
    private subscription?: Subscription;
    public readonly intents = new Subject<PushClickIntent>();

    constructor(private readonly swPush: SwPush, private readonly auth: AuthService, private readonly router: Router) {}

    public start(): void {
        if (!this.swPush.isEnabled || this.subscription) return;
        this.subscription = this.swPush.notificationClicks.pipe(
            catchError(() => of(null)),
        ).subscribe(event => {
            if (!event) return;
            if (event.action !== '') return;
            const intent = parsePushClickData(event.notification.data);
            if (intent) void this.open(intent).catch(() => undefined);
        });
    }

    public ngOnDestroy(): void { this.subscription?.unsubscribe(); }

    private async open(intent: PushClickIntent): Promise<void> {
        const token = await firstValueFrom(this.auth.restore().pipe(catchError(() => of(null))));
        if (!token) return;
        // Never accept a payload URL or navigation target; push always opens the fixed app route.
        const navigated = await this.router.navigate(['/home']);
        // Angular resolves ignored same-URL navigations as false. A live /home page is already
        // in the required destination, so it can still consume the authenticated intent.
        if (!navigated && this.router.url !== '/home') return;
        this.intents.next(intent);
    }
}

export function parsePushClickData(value: unknown): PushClickIntent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    const intentData = stripNGSWActionClick(data);
    if (!intentData) return null;
    if (intentData['kind'] === 'message' && hasExactKeys(intentData, ['kind', 'conversation_id', 'message_id']) && isUUID(intentData['conversation_id']) && isUUID(intentData['message_id'])) {
        return {kind: 'message', conversationID: intentData['conversation_id'], messageID: intentData['message_id']};
    }
    if (intentData['kind'] === 'direct_call' && hasExactKeys(intentData, ['kind', 'call_id', 'conversation_id']) && isUUID(intentData['call_id']) && isUUID(intentData['conversation_id'])) {
        return {kind: 'direct-call', callID: intentData['call_id'], conversationID: intentData['conversation_id']};
    }
    if (intentData['kind'] === 'group_call' && hasExactKeys(intentData, ['kind', 'conversation_id']) && isUUID(intentData['conversation_id'])) {
        return {kind: 'group-call', conversationID: intentData['conversation_id']};
    }
    return null;
}

function isUUID(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key)); }
function stripNGSWActionClick(value: Record<string, unknown>): Record<string, unknown> | null {
    if (!Object.prototype.hasOwnProperty.call(value, 'onActionClick')) return value;
    const actionClick = value['onActionClick'];
    if (!actionClick || typeof actionClick !== 'object' || Array.isArray(actionClick)) return null;
    const actionConfig = (actionClick as Record<string, unknown>)['default'];
    if (!actionConfig || typeof actionConfig !== 'object' || Array.isArray(actionConfig)) return null;
    const config = actionConfig as Record<string, unknown>;
    if (!hasExactKeys(actionClick as Record<string, unknown>, ['default']) || !hasExactKeys(config, ['operation', 'url']) || config['operation'] !== NGSW_ACTION_CLICK.operation || config['url'] !== NGSW_ACTION_CLICK.url) return null;
    const {onActionClick: _metadata, ...intentData} = value;
    return intentData;
}
