import {ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {MatMenuTrigger} from '@angular/material/menu';
import {AuthService} from '../../auth/auth.service';
import {Router} from '@angular/router';
import {Subscription} from 'rxjs';
import {Profile} from '../../auth/profile.model';
import {PwaService} from '../../pwa/pwa.service';

@Component({
    standalone: false,
    selector: 'app-header',
    templateUrl: './header.component.html',
    styleUrls: ['./header.component.css']
})
export class HeaderComponent implements OnInit, OnDestroy {
    @ViewChild(MatMenuTrigger) private accountMenuTrigger?: MatMenuTrigger;
    public isAuthenticated = false;
    public profile?: Profile;
    public isDarkTheme = true;
    private readonly subscriptions = new Subscription();
    private readonly themeKey = 'zwei_theme';

    constructor(private authService: AuthService, private router: Router, private changeDetector: ChangeDetectorRef, public readonly pwa: PwaService) {
    }

    public ngOnInit(): void {
        this.isDarkTheme = window.localStorage.getItem(this.themeKey) !== 'light';
        this.applyTheme();
        this.subscriptions.add(this.authService.token.subscribe(token => {
            this.isAuthenticated = !!token;
            this.pwa.setAuthenticated(this.isAuthenticated);
            this.changeDetector.markForCheck();
        }));
        this.subscriptions.add(this.authService.token.subscribe(token => {
            if (token) this.subscriptions.add(this.authService.profile().subscribe({
                next: profile => {
                    this.profile = profile;
                    this.changeDetector.markForCheck();
                }
            }));
            else {
                this.profile = undefined;
                this.changeDetector.markForCheck();
            }
        }));
    }

    public ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
    }

    @HostListener('window:resize')
    public onWindowResize(): void {
        this.applyAccountMenuTheme();
    }

    public onLogout(): void {
        this.authService.logout().subscribe(() => void this.router.navigate(['login']));
    }

    public toggleTheme(): void {
        this.isDarkTheme = !this.isDarkTheme;
        window.localStorage.setItem(this.themeKey, this.isDarkTheme ? 'dark' : 'light');
        this.applyTheme();
    }

    public applyAccountMenuTheme(): void {
        const panel = document.querySelector<HTMLElement>('.cdk-overlay-container .mat-mdc-menu-panel');
        if (!panel) return;
        if (window.matchMedia('(max-width: 600px)').matches) {
            panel.style.setProperty('position', 'fixed', 'important');
            panel.style.setProperty('top', 'auto', 'important');
            panel.style.setProperty('right', '16px', 'important');
            panel.style.setProperty('bottom', '16px', 'important');
            panel.style.setProperty('left', 'auto', 'important');
            panel.style.setProperty('transform', 'none', 'important');
        } else {
            ['position', 'top', 'right', 'bottom', 'left', 'transform'].forEach(property => panel.style.removeProperty(property));
            this.accountMenuTrigger?.updatePosition();
        }
        const foreground = this.isDarkTheme ? '#edf2fa' : '#172033';
        panel.classList.toggle('account-menu-panel-dark', this.isDarkTheme);
        panel.classList.toggle('account-menu-panel-light', !this.isDarkTheme);
        panel.style.setProperty('background-color', this.isDarkTheme ? '#263546' : '#fff', 'important');
        panel.style.setProperty('color', foreground, 'important');
        panel.style.setProperty('--mat-menu-item-label-text-color', foreground, 'important');
        panel.style.setProperty('--mat-menu-item-icon-color', foreground, 'important');
        panel.querySelectorAll<HTMLElement>('.mat-mdc-menu-item, .mat-mdc-menu-item *').forEach(item => item.style.setProperty('color', foreground, 'important'));
        panel.querySelectorAll<HTMLElement>('.mat-mdc-menu-item[disabled]').forEach(item => item.style.setProperty('opacity', '1', 'important'));
        panel.querySelector<HTMLElement>('.account-menu-name')?.style.setProperty('color', this.isDarkTheme ? '#f1f5f9' : '#172033', 'important');
        panel.querySelector<HTMLElement>('.account-menu-email')?.style.setProperty('color', this.isDarkTheme ? '#aebdd0' : '#4c6077', 'important');
    }

    public install(): void {
        void this.pwa.install();
    }

    public applyUpdate(): void {
        void this.pwa.applyUpdate();
    }

    private applyTheme(): void {
        document.documentElement.classList.toggle('dark-theme', this.isDarkTheme);
        document.documentElement.classList.toggle('light-theme', !this.isDarkTheme);
        document.body.classList.toggle('dark-theme', this.isDarkTheme);
        document.body.classList.toggle('light-theme', !this.isDarkTheme);
    }
}
