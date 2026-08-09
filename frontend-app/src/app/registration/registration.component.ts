import {Component} from '@angular/core';
import {Router} from '@angular/router';
import {MatSnackBar} from '@angular/material/snack-bar';
import {FormGroup} from '@angular/forms';
import {RegistrationForm, RegistrationModel} from './registration.model';
import {RegistrationService} from './registration.service';
import {RegistrationErrorResponse} from './registration.error.model';
import {finalize} from 'rxjs/operators';
import {ControlsOf} from '../shared/model/controlOf';
import {AuthService} from '../auth/auth.service';

@Component({
    standalone: false,
    selector: 'app-registration',
    templateUrl: './registration.component.html',
    styleUrls: ['./registration.component.css']
})
export class RegistrationComponent {
    public isLoading = false;
    public registrationForm: FormGroup<ControlsOf<RegistrationForm>>;

    constructor(
        private service: RegistrationService,
        private authService: AuthService,
        private router: Router,
        private snackBar: MatSnackBar,
    ) {
        this.registrationForm = service.buildForm();
    }

    public onSubmit(): void {
        if (this.registrationForm.invalid) {
            this.registrationForm.updateValueAndValidity();

            return;
        }

        let model: RegistrationModel;
        try {
            model = RegistrationModel.createFrom(this.registrationForm.getRawValue()) as RegistrationModel;
        } catch {
            this.showError('Please check the registration details and try again.');
            return;
        }

        this.isLoading = true;
        this.service.registration(model)
            .pipe(finalize(() => this.isLoading = false))
            .subscribe({
                 next: token => {
                     this.authService.acceptToken(token);
                     this.snackBar.dismiss();
                     this.router.navigate(['home']);
                 },
                error: (error: RegistrationErrorResponse) => this.showError(this.registrationErrorMessage(error)),
            });
    }

    public get email() {
        return this.registrationForm.controls.email;
    }

    public get password() {
        return this.registrationForm.controls.password;
    }

    public get firstName() {
        return this.registrationForm.controls.firstName;
    }

    public get lastName() {
        return this.registrationForm.controls.lastName;
    }

    public get nickName() {
        return this.registrationForm.controls.nickName;
    }

    public get confirmPassword() {
        return this.registrationForm.controls.confirmPassword;
    }

    public get passwordsMatch(): boolean {
        return this.password.value.length > 0
            && this.confirmPassword.value.length > 0
            && this.password.value === this.confirmPassword.value;
    }

    private registrationErrorMessage(error: RegistrationErrorResponse): string {
        if (error?.status === 409) {
            return 'An account with this email already exists. Try signing in instead.';
        }
        if (error?.status === 400 && error.invalidParams?.length) {
            return error.invalidParams.map(param => param.reason).join('\n');
        }
        if (typeof error?.error?.error === 'string') {
            return error.error.error;
        }
        return 'We could not create your account. Please try again.';
    }

    private showError(message: string): void {
        this.isLoading = false;
        this.snackBar.open(message, 'Close', {
            duration: 60 * 1000,
            horizontalPosition: 'center',
            verticalPosition: 'top',
        });
    }
}
