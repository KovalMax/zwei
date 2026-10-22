import {ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit} from '@angular/core';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {HostService} from '../auth/host.service';
import {AlertMode, BrowserNotificationService} from '../notifications/notification.service';
import {firstValueFrom} from 'rxjs';

@Component({
    standalone: false,
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-profile',
    templateUrl: './profile.component.html',
    styleUrls: ['./profile.component.css']
})
export class ProfileComponent implements OnInit {
    public profile?: Profile;
    public error = false;
    public mediaSaving = false;
    public mediaSaveError = false;
    public alertMode?: AlertMode;
    public alertSaveError = false;
    public alertSaving = false;
    public readonly backRoute: string;
    public readonly backLabel: string;

    constructor(private authService: AuthService, private changeDetector: ChangeDetectorRef, host: HostService, public readonly notifications: BrowserNotificationService) {
        this.backRoute = host.isAdminHost() ? '/admin' : '/home';
        this.backLabel = host.isAdminHost() ? 'Back to KYC admin' : 'Back to chats';
    }

    public async setAlertMode(mode: AlertMode): Promise<void> {
        if (this.alertSaving || mode === this.alertMode) return;
        this.alertSaving = true;
        this.alertSaveError = false;
        this.changeDetector.markForCheck();
        try {
            // Trigger permission prompts/audio unlock directly from the user's
            // gesture; these browser-local capabilities do not alter the saved
            // account preference.
            await this.notifications.prepareCapabilities(mode);
            const profile = await firstValueFrom(this.authService.updateProfile({alert_mode: mode}));
            this.profile = profile;
            const alertMode = profile.alert_mode ?? 'off';
            this.alertMode = alertMode;
            this.notifications.setMode(alertMode);
        } catch {
            this.alertSaveError = true;
        } finally {
            this.alertSaving = false;
            this.changeDetector.markForCheck();
        }
    }

    public setMediaAutoLoad(enabled: boolean): void {
        if (!this.profile || this.mediaSaving) return;
        const previous = this.profile.auto_load_approved_media;
        this.profile = {...this.profile, auto_load_approved_media: enabled};
        this.mediaSaving = true;
        this.mediaSaveError = false;
        this.authService.updateProfile({auto_load_approved_media: enabled}).subscribe({
            next: profile => { this.profile = profile; this.mediaSaving = false; this.changeDetector.markForCheck(); },
            error: () => { if (this.profile) this.profile = {...this.profile, auto_load_approved_media: previous}; this.mediaSaving = false; this.mediaSaveError = true; this.changeDetector.markForCheck(); },
        });
    }

    public readChecked(event: Event): boolean {
        return event.target instanceof HTMLInputElement && event.target.checked;
    }

    public ngOnInit(): void {
        this.authService.profile().subscribe({
            next: profile => {
                this.profile = profile;
                const alertMode = profile.alert_mode ?? 'off';
                this.alertMode = alertMode;
                this.notifications.setMode(alertMode);
                this.changeDetector.markForCheck();
            },
            error: () => {
                this.error = true;
                this.changeDetector.markForCheck();
            },
        });
    }
}
