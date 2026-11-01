import {ChangeDetectorRef, Component, OnInit} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import {AuthService} from '../auth/auth.service';
import {finalize} from 'rxjs/operators';
import {FormControl, FormGroup, Validators} from '@angular/forms';
import {AuthCookieLockUnavailableError} from '../auth/auth-cookie-lock.service';

@Component({
    standalone: false,
    selector: 'app-activation',
    templateUrl: './activation.component.html',
    styleUrls: ['../auth/auth-surface.css', './activation.component.css'],
})
export class ActivationComponent implements OnInit {
    public isLoading = true;
    public activated = false;
    public error = false;
    public setupMode = false;
    public passwordSet = false;
    public legacySetupComplete = false;
    public sessionAcceptanceFailed = false;
    public lockUnavailable = false;
    public setupToken: string | null = null;
    public readonly passwordForm = new FormGroup({
        password: new FormControl('', {nonNullable: true, validators: [Validators.required, Validators.minLength(8), Validators.maxLength(64)]}),
        confirmPassword: new FormControl('', {nonNullable: true, validators: [Validators.required, Validators.minLength(8), Validators.maxLength(64)]}),
    });

    constructor(private route: ActivatedRoute, private auth: AuthService, private router: Router, private changeDetector: ChangeDetectorRef) {}

    public ngOnInit(): void {
        const legacyToken = this.route.snapshot.queryParamMap.get('token');
        if (legacyToken) {
            this.setupMode = false;
            this.auth.activate(legacyToken).pipe(finalize(() => { this.isLoading = false; this.changeDetector.markForCheck(); })).subscribe({
                next: () => { this.activated = true; this.changeDetector.markForCheck(); },
                error: () => { this.error = true; this.changeDetector.markForCheck(); },
            });
            return;
        }
        const setupFragment = window.location.hash;
        const match = /^#setup=([A-Za-z0-9_-]{43})$/.exec(setupFragment);
        if (setupFragment.startsWith('#setup=')) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        if (!match) {
            this.isLoading = false;
            this.error = true;
            this.setupMode = setupFragment.startsWith('#setup=');
            return;
        }
        this.setupMode = true;
        this.setupToken = match[1];
        this.isLoading = false;
    }

    public submitPassword(): void {
        this.passwordForm.markAllAsTouched();
        if (this.passwordForm.invalid || this.password !== this.confirmPassword || !this.setupToken || this.isLoading) return;
        this.isLoading = true;
        this.error = false;
        this.sessionAcceptanceFailed = false;
        this.lockUnavailable = false;
        this.auth.setupPassword(this.setupToken, this.password).pipe(finalize(() => { this.isLoading = false; this.changeDetector.markForCheck(); })).subscribe({
            next: session => {
                if (session === null) {
                    this.legacySetupComplete = true;
                    this.passwordSet = true;
                    this.setupToken = null;
                    this.changeDetector.markForCheck();
                    return;
                }
                try {
                    this.auth.acceptToken(session);
                    this.passwordSet = true;
                    this.setupToken = null;
                    this.changeDetector.markForCheck();
                    void this.router.navigate([this.auth.defaultAuthenticatedRoute()]);
                } catch {
                    this.passwordSet = true;
                    this.setupToken = null;
                    this.sessionAcceptanceFailed = true;
                    this.changeDetector.markForCheck();
                }
            },
            error: error => {
                this.lockUnavailable = error instanceof AuthCookieLockUnavailableError;
                this.error = true;
                this.changeDetector.markForCheck();
            },
        });
    }

    public get password(): string { return this.passwordForm.controls.password.value; }
    public get confirmPassword(): string { return this.passwordForm.controls.confirmPassword.value; }
    public get passwordsMatch(): boolean { return this.password.length > 0 && this.password === this.confirmPassword; }

    public get title(): string {
        if (this.setupMode) return this.isLoading ? 'Setting your password…' : this.passwordSet ? 'Password setup complete' : this.error ? 'Password setup unavailable' : 'Set your password';
        return this.isLoading ? 'Activating your account…' : this.activated ? 'Your account is active' : 'Activation link unavailable';
    }

    public goToLogin(): void {
        void this.router.navigate(['/login']);
    }
}
