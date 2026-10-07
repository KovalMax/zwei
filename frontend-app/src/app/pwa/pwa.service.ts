import {Injectable, NgZone, OnDestroy} from '@angular/core';
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
    private deferredInstall?: BeforeInstallPromptEvent;
    private readonly subscriptions = new Subscription();
    private readonly offlineListener: () => void;
    private readonly onlineListener: () => void;
    private readonly installListener: (event: Event) => void;

    public constructor(private readonly updates: SwUpdate, private readonly zone: NgZone) {
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
        window.addEventListener('offline', this.offlineListener);
        window.addEventListener('online', this.onlineListener);
        window.addEventListener('beforeinstallprompt', this.installListener);
        if (updates.isEnabled) {
            this.subscriptions.add(updates.versionUpdates.subscribe(event => {
                if (event.type === 'VERSION_READY') this.updateAvailable = true;
            }));
        }
    }

    public ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
        window.removeEventListener('offline', this.offlineListener);
        window.removeEventListener('online', this.onlineListener);
        window.removeEventListener('beforeinstallprompt', this.installListener);
    }

    public setAuthenticated(authenticated: boolean): void {
        this.authenticated = authenticated;
        this.canInstall = authenticated && this.deferredInstall !== undefined;
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

    private captureInstallPrompt(event: Event): void {
        if (!isBeforeInstallPromptEvent(event)) return;
        event.preventDefault();
        this.deferredInstall = event;
        this.canInstall = this.authenticated;
    }

    private clearOfflineState(): void {
        sessionStorage.removeItem(offlineSessionKey);
        this.offlineChanges.next(false);
        this.observedOfflineEvent = false;
    }
}
