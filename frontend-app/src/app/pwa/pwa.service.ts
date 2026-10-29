import {Injectable, NgZone, OnDestroy, Inject} from '@angular/core';
import {DOCUMENT} from '@angular/common';
import {SwUpdate} from '@angular/service-worker';
import {BehaviorSubject, Subscription} from 'rxjs';

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>;
}

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
    return 'prompt' in event && 'userChoice' in event;
}

const offlineSessionKey = 'zwei.pwa.offline';

function isOfflineAtStartup(): boolean {
    return !navigator.onLine || sessionStorage.getItem(offlineSessionKey) === 'true';
}

@Injectable({providedIn: 'root'})
export class PwaService implements OnDestroy {
    public canInstall = false;
    public updateAvailable = false;
    public readonly offlineChanges = new BehaviorSubject(isOfflineAtStartup());
    private restoredOfflineMarker = sessionStorage.getItem(offlineSessionKey) === 'true';
    private observedOfflineEvent = false;
    private authenticated = false;
    private unreadCount = 0;
    private badgeSyncRunning = false;
    private deferredInstall?: BeforeInstallPromptEvent;
    private readonly subscriptions = new Subscription();
    private readonly offlineListener: () => void;
    private readonly onlineListener: () => void;
    private readonly installListener: (event: Event) => void;
    private readonly visibilityListener: () => void;
    private updateTimer?: ReturnType<typeof setInterval>;

    public constructor(private readonly updates: SwUpdate, private readonly zone: NgZone, @Inject(DOCUMENT) private readonly document: Document) {
        this.offlineListener = () => this.zone.run(() => {
            this.observedOfflineEvent = true;
            sessionStorage.setItem(offlineSessionKey, 'true');
            this.offlineChanges.next(true);
        });
        this.onlineListener = () => this.zone.run(() => {
            // A marker restored from an earlier document is deliberately sticky:
            // online events can fire before the browser has working connectivity.
            if (this.restoredOfflineMarker || !this.observedOfflineEvent) return;
            this.clearOfflineState();
        });
        this.installListener = event => this.zone.run(() => this.captureInstallPrompt(event));
        this.visibilityListener = () => {
            if (this.document.visibilityState === 'visible') this.checkForUpdate();
        };
        window.addEventListener('offline', this.offlineListener);
        window.addEventListener('online', this.onlineListener);
        window.addEventListener('beforeinstallprompt', this.installListener);
        if (updates.isEnabled) {
            this.subscriptions.add(updates.versionUpdates.subscribe(event => {
                if (event.type === 'VERSION_READY') this.updateAvailable = true;
            }));
            this.document.addEventListener('visibilitychange', this.visibilityListener);
            this.updateTimer = setInterval(() => this.checkForUpdate(), 6 * 60 * 60 * 1000);
            this.checkForUpdate();
        }
    }

    public ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
        window.removeEventListener('offline', this.offlineListener);
        window.removeEventListener('online', this.onlineListener);
        window.removeEventListener('beforeinstallprompt', this.installListener);
        this.document.removeEventListener('visibilitychange', this.visibilityListener);
        if (this.updateTimer) clearInterval(this.updateTimer);
    }

    public setAuthenticated(authenticated: boolean): void {
        this.authenticated = authenticated;
        if (!authenticated) this.unreadCount = 0;
        this.canInstall = authenticated && this.deferredInstall !== undefined;
        this.synchronizeAppBadge();
    }

    public setUnreadCount(count: number): void {
        if (!this.authenticated) return;
        this.unreadCount = Math.max(0, count);
        this.synchronizeAppBadge();
    }

    public get isOffline(): boolean {
        return this.offlineChanges.value;
    }

    /** Clears offline UI only after an HTTP response proves network reachability. */
    public confirmNetworkResponse(): void {
        if (this.offlineChanges.value) this.clearOfflineState();
        this.restoredOfflineMarker = false;
    }

    public async install(): Promise<void> {
        const prompt = this.deferredInstall;
        if (!this.authenticated || !prompt) return;
        await prompt.prompt();
        await prompt.userChoice;
        this.deferredInstall = undefined;
        this.canInstall = false;
    }

    public async applyUpdate(): Promise<void> {
        if (!this.authenticated || !this.updateAvailable || !this.updates.isEnabled) return;
        if (await this.updates.activateUpdate()) window.location.reload();
    }

    public async refreshApp(): Promise<void> {
        if (!this.authenticated) return;
        if (this.updates.isEnabled) {
            try {
                const updateFound = await this.updates.checkForUpdate();
                if (updateFound || this.updateAvailable) await this.updates.activateUpdate();
            } catch {
                // Still reload so the browser can request the latest app shell.
            }
        }
        this.document.defaultView?.location.reload();
    }

    private captureInstallPrompt(event: Event): void {
        if (!isBeforeInstallPromptEvent(event)) return;
        event.preventDefault();
        this.deferredInstall = event;
        this.canInstall = this.authenticated;
    }

    private checkForUpdate(): void {
        if (!this.updates.isEnabled) return;
        void this.updates.checkForUpdate().catch(() => undefined);
    }

    private clearOfflineState(): void {
        sessionStorage.removeItem(offlineSessionKey);
        this.offlineChanges.next(false);
        this.observedOfflineEvent = false;
    }

    private synchronizeAppBadge(): void {
        if (this.badgeSyncRunning) return;
        this.badgeSyncRunning = true;
        void this.drainAppBadgeUpdates();
    }

    private async drainAppBadgeUpdates(): Promise<void> {
        try {
            let applied: number | null | undefined;
            do {
                const desired = this.authenticated && this.unreadCount > 0 ? this.unreadCount : null;
                await this.applyAppBadge(desired);
                applied = desired;
            } while (applied !== (this.authenticated && this.unreadCount > 0 ? this.unreadCount : null));
        } finally {
            this.badgeSyncRunning = false;
        }
    }

    private async applyAppBadge(count: number | null): Promise<void> {
        const badgeNavigator = this.document.defaultView?.navigator;
        if (!badgeNavigator) return;
        try {
            if (count === null) {
                if (typeof badgeNavigator.clearAppBadge === 'function') await badgeNavigator.clearAppBadge();
            } else if (typeof badgeNavigator.setAppBadge === 'function') {
                await badgeNavigator.setAppBadge(count);
            }
        } catch {
            // Badge support is optional and must not affect chat.
        }
    }
}
