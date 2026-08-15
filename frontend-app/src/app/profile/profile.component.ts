import {ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit} from '@angular/core';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {HostService} from '../auth/host.service';

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

    constructor(private authService: AuthService, private changeDetector: ChangeDetectorRef, host: HostService) {
        this.backRoute = host.isAdminHost() ? '/admin' : '/home';
        this.backLabel = host.isAdminHost() ? 'Back to KYC admin' : 'Back to chats';
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
