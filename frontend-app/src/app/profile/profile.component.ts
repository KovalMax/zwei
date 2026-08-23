import {ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit} from '@angular/core';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {HostService} from '../auth/host.service';
import {AlertMode, BrowserNotificationService} from '../notifications/notification.service';

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
    public readonly backRoute: string;
    public readonly backLabel: string;

    constructor(private authService: AuthService, private changeDetector: ChangeDetectorRef, host: HostService, public readonly notifications: BrowserNotificationService) {
        this.backRoute = host.isAdminHost() ? '/admin' : '/home';
        this.backLabel = host.isAdminHost() ? 'Back to KYC admin' : 'Back to chats';
    }

    public async setAlertMode(mode: AlertMode): Promise<void> {
        if (mode === 'off') this.notifications.disable();
        else if (mode === 'sounds') await this.notifications.enableSounds();
        else await this.notifications.enable();
        this.changeDetector.markForCheck();
    }

    public ngOnInit(): void {
        this.authService.profile().subscribe({
            next: profile => {
                this.profile = profile;
                this.changeDetector.markForCheck();
            },
            error: () => {
                this.error = true;
                this.changeDetector.markForCheck();
            },
        });
    }
}
