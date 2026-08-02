import {Injectable} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {RegistrationForm, RegistrationModel, RegistrationResponse} from './registration.model';
import {backends} from '../../environments/environment';
import {Observable, throwError} from 'rxjs';
import {catchError} from 'rxjs/operators';
import {FormControl, FormGroup, Validators} from '@angular/forms';
import {ApplicationValidators} from '../shared/validator/ApplicationValidators';
import {ControlsOf} from '../shared/model/controlOf';

@Injectable()
export class RegistrationService {
    constructor(
        private client: HttpClient
    ) {
    }

    readonly registrationForm = new FormGroup<ControlsOf<RegistrationForm>>({
            email: new FormControl<string>(
                '',
                {
                    validators: [
                        Validators.required,
                        Validators.email,
                        Validators.maxLength(180),
                    ],
                    nonNullable: true,
                }
            ),
            password: new FormControl<string>(
                '',
                {
                    validators: [
                        Validators.required,
                        Validators.minLength(8),
                        Validators.maxLength(64),
                    ],
                    nonNullable: true,
                }
            ),
            confirmPassword: new FormControl<string>(
                '',
                {
                    validators: [
                        Validators.required,
                        Validators.minLength(8),
                        Validators.maxLength(64),
                    ],
                    nonNullable: true,
                }
            ),
            firstName: new FormControl<string>(
                '',
                {
                    validators: [
                        Validators.required,
                        Validators.minLength(2),
                        Validators.maxLength(60)
                    ],
                    nonNullable: true,
                }
            ),
            lastName: new FormControl<string>(
                '',
                {
                    validators: [
                        Validators.required,
                        Validators.minLength(2),
                        Validators.maxLength(60)
                    ],
                    nonNullable: true,
                }
            ),
            nickName: new FormControl<string>(
                '',
                {
                    validators: [
                        Validators.required,
                        Validators.minLength(2),
                        Validators.maxLength(60)
                    ],
                    nonNullable: true,
                }
            )
        },
        {
            validators: ApplicationValidators.valuesAreEqual('password', 'confirmPassword'),
        }
    );

    public registration(model: RegistrationModel): Observable<RegistrationResponse> {
        return this.client
            .post<RegistrationResponse>(backends.registration, model)
            .pipe(
                catchError((err: HttpErrorResponse) => throwError(() => ({
                    status: err.status,
                    invalidParams: err.error?.invalidParams ?? [],
                    error: err.error,
                })))
            );
    }

    public buildForm(): FormGroup<ControlsOf<RegistrationForm>> {
        return this.registrationForm;
    }
}
