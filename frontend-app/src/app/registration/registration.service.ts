import {Injectable} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {RegistrationForm, RegistrationModel, RegistrationResponse} from './registration.model';
import {Observable, throwError} from 'rxjs';
import {catchError, map} from 'rxjs/operators';
import {FormControl, FormGroup, Validators} from '@angular/forms';
import {ApplicationValidators} from '../shared/validator/ApplicationValidators';
import {ControlsOf} from '../shared/model/controlOf';
import {AuthCookieLockService, AuthCookieLockUnavailableError} from '../auth/auth-cookie-lock.service';
import {HostService} from '../auth/host.service';
import {AuthService} from '../auth/auth.service';

@Injectable()
export class RegistrationService {
    constructor(
        private client: HttpClient,
        private cookieLock: AuthCookieLockService,
        private host: HostService,
        private auth: AuthService
    ) {
    }

    public registration(model: RegistrationModel): Observable<RegistrationResponse> {
        const endpoint = this.host.browserSessionEndpoint('register');
        return this.cookieLock.run(() => this.auth.pendingLogout
            ? throwError(() => new HttpErrorResponse({error: {error: 'Complete the pending sign out first'}}))
            : this.client.post<unknown>(endpoint, model, {withCredentials: true}))
            .pipe(
                map(response => this.parseV2Response(response, !!model.invitation_code?.trim())),
                catchError((err: HttpErrorResponse | AuthCookieLockUnavailableError) => err instanceof AuthCookieLockUnavailableError ? throwError(() => err) : throwError(() => ({
                    status: err.status,
                    invalidParams: err.error?.invalidParams ?? [],
                    error: err.error,
                })))
            );
    }

    private parseV2Response(response: unknown, invited: boolean): RegistrationResponse {
        if (typeof response !== 'object' || response === null) throw new Error('Invalid registration response');
        if ('status' in response && response.status === 'pending') return {status: 'pending'};
        if (!invited || !('browser_id' in response) || typeof response.browser_id !== 'string' || !response.browser_id.trim() ||
            !('generation' in response) || typeof response.generation !== 'string' || !response.generation.trim() ||
            !('access_token' in response) || typeof response.access_token !== 'string' || !response.access_token ||
            !('token_type' in response) || typeof response.token_type !== 'string' || !response.token_type ||
            !('expires_in' in response) || typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in) || response.expires_in <= 0) {
            throw new Error('Invalid registration response');
        }
        return {browser_id: response.browser_id, generation: response.generation, access_token: response.access_token, token_type: response.token_type, expires_in: response.expires_in};
    }

    public buildForm(): FormGroup<ControlsOf<RegistrationForm>> {
        return new FormGroup<ControlsOf<RegistrationForm>>({
            email: new FormControl('', {validators: [Validators.required, Validators.email, Validators.maxLength(180)], nonNullable: true}),
            password: new FormControl('', {validators: [Validators.required, Validators.minLength(8), Validators.maxLength(64)], nonNullable: true}),
            confirmPassword: new FormControl('', {validators: [Validators.required, Validators.minLength(8), Validators.maxLength(64)], nonNullable: true}),
            firstName: new FormControl('', {validators: [Validators.required, Validators.minLength(2), Validators.maxLength(60)], nonNullable: true}),
            lastName: new FormControl('', {validators: [Validators.required, Validators.minLength(2), Validators.maxLength(60)], nonNullable: true}),
            nickName: new FormControl('', {validators: [Validators.required, Validators.minLength(2), Validators.maxLength(60)], nonNullable: true}),
        }, {
            validators: ApplicationValidators.valuesAreEqual('password', 'confirmPassword'),
        });
    }
}
