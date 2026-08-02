import {Component, OnDestroy, OnInit} from '@angular/core';
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
    private tokenSubscription!: Subscription;
    private readonly themeKey = 'zwei_theme';

    constructor(private authService: AuthService, private router: Router) {
    }

    public ngOnInit(): void {
        this.isDarkTheme = window.localStorage.getItem(this.themeKey) !== 'light';
        this.applyTheme();
        this.tokenSubscription = this.authService.token.subscribe(token => this.isAuthenticated = !!token);
        this.authService.token.subscribe(token => {
            if (token) this.authService.profile().subscribe({next: profile => this.profile = profile});
            else this.profile = undefined;
        });
    }

    public ngOnDestroy(): void {
        this.tokenSubscription.unsubscribe();
    }

    public onLogout(): void {
        this.authService.logout();
        this.router.navigate(['login']);
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
