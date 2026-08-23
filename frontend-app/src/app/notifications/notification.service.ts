import {Inject, Injectable, InjectionToken} from '@angular/core';
import {BehaviorSubject, Observable} from 'rxjs';

export type BrowserNotificationPermission = NotificationPermission | 'unsupported';
export type AlertMode = 'off' | 'sounds' | 'notifications';

export interface BrowserNotificationPort {
    readonly supported: boolean;
    readonly permission: BrowserNotificationPermission;
    requestPermission(): Promise<BrowserNotificationPermission>;
    show(title: string, options: NotificationOptions): void;
}

export interface SoundPort {
    unlock(): Promise<boolean>;
    playMessage(): void;
    startCall(): void;
    stopCall(): void;
}

const browserNotificationPort: BrowserNotificationPort = {
    get supported(): boolean {
        return typeof window !== 'undefined' && typeof window.Notification === 'function';
    },
    get permission(): BrowserNotificationPermission {
        return this.supported ? window.Notification.permission : 'unsupported';
    },
    async requestPermission(): Promise<BrowserNotificationPermission> {
        if (!this.supported) return 'unsupported';
        try {
            return await window.Notification.requestPermission();
        } catch {
            return this.permission;
        }
    },
    show(title: string, options: NotificationOptions): void {
        if (!this.supported || this.permission !== 'granted') return;
        try {
            const notification = new window.Notification(title, options);
            notification.onclick = () => {
                window.focus();
                notification.close();
            };
        } catch {
            // Browser notification failures must not affect realtime state.
        }
    },
};

type AudioContextConstructor = new () => AudioContext;
type AudioWindow = Window & {AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor};

class WebAudioSoundPort implements SoundPort {
    private context?: AudioContext;
    private callTimer?: number;

    public async unlock(): Promise<boolean> {
        const context = this.getContext();
        if (!context) return false;
        try {
            if (context.state === 'suspended') await context.resume();
            return context.state === 'running';
        } catch {
            return false;
        }
    }

    public playMessage(): void { this.playTone(880, 0.09); }

    public startCall(): void {
        if (this.callTimer !== undefined) return;
        this.playTone(660, 0.3);
        if (typeof window === 'undefined') return;
        this.callTimer = window.setInterval(() => this.playTone(660, 0.3), 1_600);
    }

    public stopCall(): void {
        if (this.callTimer !== undefined && typeof window !== 'undefined') window.clearInterval(this.callTimer);
        this.callTimer = undefined;
    }

    private getContext(): AudioContext | undefined {
        if (this.context) return this.context;
        if (typeof window === 'undefined') return undefined;
        const audioWindow = window as AudioWindow;
        const Constructor = audioWindow.AudioContext || audioWindow.webkitAudioContext;
        if (!Constructor) return undefined;
        try {
            this.context = new Constructor();
            return this.context;
        } catch {
            return undefined;
        }
    }

    private playTone(frequency: number, duration: number): void {
        const context = this.context;
        if (!context || context.state !== 'running') return;
        try {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const start = context.currentTime;
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(start);
            oscillator.stop(start + duration + 0.02);
        } catch {
            // Audio failures must not affect realtime state or notification cleanup.
        }
    }
}

export const BROWSER_NOTIFICATION_PORT = new InjectionToken<BrowserNotificationPort>('ZWEI_BROWSER_NOTIFICATION_PORT', {
    providedIn: 'root',
    factory: () => browserNotificationPort,
});

export const SOUND_PORT = new InjectionToken<SoundPort>('ZWEI_SOUND_PORT', {
    providedIn: 'root',
    factory: () => new WebAudioSoundPort(),
});

@Injectable({providedIn: 'root'})
export class BrowserNotificationService {
    private readonly storageKey = 'zwei_alert_mode';
    private readonly permissionSubject: BehaviorSubject<BrowserNotificationPermission>;
    private alertMode: AlertMode = 'off';
    public readonly permissionChanges: Observable<BrowserNotificationPermission>;
    private readonly unlockOnGesture = (): void => {
        if (this.areSoundsEnabled) void this.sound.unlock();
    };

    public constructor(
        @Inject(BROWSER_NOTIFICATION_PORT) private readonly browser: BrowserNotificationPort,
        @Inject(SOUND_PORT) private readonly sound: SoundPort,
    ) {
        this.permissionSubject = new BehaviorSubject<BrowserNotificationPermission>(browser.permission);
        this.permissionChanges = this.permissionSubject.asObservable();
        this.alertMode = this.readStoredMode();
        if (this.alertMode !== 'off') window.addEventListener('pointerdown', this.unlockOnGesture, {once: true});
    }

    public get notificationPermission(): BrowserNotificationPermission { return this.permissionSubject.value; }
    public get notificationsSupported(): boolean { return this.browser.supported; }
    public get areSoundsEnabled(): boolean { return this.alertMode !== 'off'; }
    public get mode(): AlertMode { return this.alertMode; }

    public async enable(): Promise<BrowserNotificationPermission> {
        // Start both browser capabilities in the original click task. Browsers may
        // consume transient user activation while displaying the permission prompt.
        const soundsPromise = this.unlockSounds();
        let permission = this.browser.permission;
        if (permission === 'default') {
            try {
                permission = await this.browser.requestPermission();
            } catch {
                permission = this.browser.permission;
            }
        }
        this.setMode(await soundsPromise ? permission === 'granted' ? 'notifications' : 'sounds' : 'off');
        this.permissionSubject.next(permission);
        return permission;
    }

    public async enableSounds(): Promise<void> {
        this.setMode(await this.unlockSounds() ? 'sounds' : 'off');
    }

    public disable(): void {
        this.setMode('off');
        this.stopCallRingtone();
    }

    public showMessageNotification(conversationID: string): void {
        this.show('New message', 'You have a new message.', `zwei-message-${conversationID}`);
    }

    public showCallNotification(callID: string): void {
        this.show('Incoming call', 'You have an incoming audio call.', `zwei-call-${callID}`);
    }

    public playMessageSound(): void {
        if (this.areSoundsEnabled) this.sound.playMessage();
    }

    public startCallRingtone(): void {
        if (this.areSoundsEnabled) this.sound.startCall();
    }

    public stopCallRingtone(): void { this.sound.stopCall(); }

    private show(title: string, body: string, tag: string): void {
        if (this.alertMode !== 'notifications' || this.notificationPermission !== 'granted') return;
        this.browser.show(title, {body, tag});
    }

    private async unlockSounds(): Promise<boolean> {
        try {
            return await this.sound.unlock();
        } catch {
            return false;
        }
    }

    private setMode(mode: AlertMode): void {
        this.alertMode = mode;
        window.localStorage.setItem(this.storageKey, mode);
    }

    private readStoredMode(): AlertMode {
        const mode = window.localStorage.getItem(this.storageKey);
        return mode === 'sounds' || mode === 'notifications' ? mode : 'off';
    }
}
