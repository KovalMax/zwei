import {ChangeDetectorRef, Component} from '@angular/core';
import {FormControl, FormGroup, Validators} from '@angular/forms';
import {AuthService} from '../auth/auth.service';
import {Router} from '@angular/router';
import {MatSnackBar} from '@angular/material/snack-bar';
import {finalize} from 'rxjs/operators';
import {HttpErrorResponse} from '@angular/common/http';
import {ControlsOf} from '../shared/model/controlOf';
import {getDeviceID, Login} from './login';
import {HostService} from '../auth/host.service';

@Component({
    standalone: false,
    selector: 'app-login',
    templateUrl: './login.component.html',
    styleUrls: ['./login.component.css']
})

export class LoginComponent {
    public isLoading = false;
    public readonly isAdminHost: boolean;
    public loginForm: FormGroup<ControlsOf<Login>>;

    constructor(
        private client: AuthService,
        private router: Router,
        private snackBar: MatSnackBar,
        private changeDetector: ChangeDetectorRef,
        host: HostService,
    ) {
        this.isAdminHost = host.isAdminHost();
        this.loginForm = new FormGroup<ControlsOf<Login>>({
            email: new FormControl(
                '',
                {
                    validators: [Validators.required, Validators.email],
                    nonNullable: true
                }
            ),
            password: new FormControl(
                '',
                {
                    validators: [Validators.required],
                    nonNullable: true
                }
            )
        });
    }

    public onSubmit(): void {
        if (this.loginForm.invalid) {
            return;
        }

        this.isLoading = true;
        this.client
            .login({
                ...this.loginForm.getRawValue(),
                device_id: getDeviceID(),
                device_name: 'Browser',
            })
            .pipe(finalize(() => {
                this.isLoading = false;
                this.changeDetector.markForCheck();
            }))
            .subscribe({
                next: () => {
                    this.snackBar.dismiss();
                    void this.router.navigate([this.client.defaultAuthenticatedRoute()]);
                },
                error: (error: string | HttpErrorResponse) => this.showError(this.loginErrorMessage(error)),
            });
    }

    public get email() {
        return this.loginForm.controls.email;
    }

    public get password() {
        return this.loginForm.controls.password;
    }

    private loginErrorMessage(error: string | HttpErrorResponse): string {
        if (typeof error === 'string') {
            return error;
        }
        if (error.status === 401) {
            return 'Email or password is incorrect.';
        }
        if (typeof error.error?.error === 'string') {
            return error.error.error;
        }
        return 'We could not sign you in. Please try again.';
    }

    private showError(message: string): void {
        this.isLoading = false;
        this.changeDetector.markForCheck();
        this.snackBar.open(message, 'Close', {
            duration: 60 * 1000,
            horizontalPosition: 'center',
            verticalPosition: 'top',
        });
    }
}
