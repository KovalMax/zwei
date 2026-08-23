import {ChangeDetectorRef, Component, OnDestroy, OnInit} from '@angular/core';
import {AuthService} from '../../auth/auth.service';
import {Router} from '@angular/router';
import {Subscription} from 'rxjs';
import {Profile} from '../../auth/profile.model';

@Component({
    standalone: false,
    selector: 'app-header',
    templateUrl: './header.component.html',
    styleUrls: ['./header.component.css']
})
export class HeaderComponent implements OnInit, OnDestroy {
    public isAuthenticated = false;
    public profile?: Profile;
    public isDarkTheme = true;
    private readonly subscriptions = new Subscription();
    private readonly themeKey = 'zwei_theme';

    constructor(private authService: AuthService, private router: Router, private changeDetector: ChangeDetectorRef) {
    }

    public ngOnInit(): void {
        this.isDarkTheme = window.localStorage.getItem(this.themeKey) !== 'light';
        this.applyTheme();
        this.subscriptions.add(this.authService.token.subscribe(token => {
            this.isAuthenticated = !!token;
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

    public onLogout(): void {
        this.authService.logout().subscribe(() => void this.router.navigate(['login']));
    }

    public toggleTheme(): void {
        this.isDarkTheme = !this.isDarkTheme;
        window.localStorage.setItem(this.themeKey, this.isDarkTheme ? 'dark' : 'light');
        this.applyTheme();
    }

    private applyTheme(): void {
        document.documentElement.classList.toggle('dark-theme', this.isDarkTheme);
        document.documentElement.classList.toggle('light-theme', !this.isDarkTheme);
        document.body.classList.toggle('dark-theme', this.isDarkTheme);
        document.body.classList.toggle('light-theme', !this.isDarkTheme);
    }
}
