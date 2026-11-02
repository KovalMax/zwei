import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ActivatedRoute, Router} from '@angular/router';
import {of, Subject, throwError} from 'rxjs';
import {AppModule} from '../app.module';
import {AuthService} from '../auth/auth.service';
import {ActivationComponent} from './activation.component';
import {ActivationSetupSession} from '../auth/auth.service';
import {AuthCookieLockUnavailableError} from '../auth/auth-cookie-lock.service';

describe('ActivationComponent', () => {
    let fixture: ComponentFixture<ActivationComponent>;
    let component: ActivationComponent;
    const token = 'A'.repeat(43);

    beforeEach(async () => {
        localStorage.removeItem('zwei.intended-session');
        localStorage.removeItem('zwei.pending-logout');
        await TestBed.configureTestingModule({
            imports: [AppModule],
            providers: [{provide: ActivatedRoute, useValue: {snapshot: {queryParamMap: {get: () => null}}}}],
        }).compileComponents();
        history.replaceState(null, '', `/activate#setup=${token}`);
        fixture = TestBed.createComponent(ActivationComponent);
        component = fixture.componentInstance;
    });

    afterEach(() => history.replaceState(null, '', '/'));

    it('submits the fragment token and accepts the returned session before navigating home', () => {
        const auth = TestBed.inject(AuthService);
        const request = new Subject<ActivationSetupSession | null>();
        const setup = vi.spyOn(auth, 'setupPassword').mockReturnValue(request);
        const acceptToken = vi.spyOn(auth, 'acceptToken');
        const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
        fixture.detectChanges();
        expect(component.setupToken).toBe(token);
        expect(window.location.hash).toBe('');
        component.passwordForm.setValue({password: 'password123', confirmPassword: 'password123'});
        component.submitPassword();
        expect(component.isLoading).toBe(true);
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Saving your password');
        expect(setup).toHaveBeenCalledWith(token, 'password123');
        const accessToken = `header.${btoa(JSON.stringify({sub: 'user'}))}.signature`;
        const session: ActivationSetupSession = {status: 'password_set', browser_id: 'browser', generation: 'one', access_token: accessToken, token_type: 'Bearer', expires_in: 900};
        request.next(session);
        request.complete();
        fixture.detectChanges();
        expect(component.passwordSet).toBe(true);
        expect(component.setupToken).toBeNull();
        expect(window.location.hash).toBe('');
        expect(acceptToken).toHaveBeenCalledWith(session);
        expect(auth.token.value?.access_token).toBe(accessToken);
        expect(navigate).toHaveBeenCalledWith(['home']);
        expect(localStorage.getItem('zwei.intended-session')).not.toBeNull();
    });

    it('explains legacy password setup without creating a session or claiming sign-in', () => {
        const auth = TestBed.inject(AuthService);
        const acceptToken = vi.spyOn(auth, 'acceptToken');
        const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
        vi.spyOn(auth, 'setupPassword').mockReturnValue(of(null));
        fixture.detectChanges();
        component.passwordForm.setValue({password: 'password123', confirmPassword: 'password123'});
        component.submitPassword();
        fixture.detectChanges();
        expect(component.legacySetupComplete).toBe(true);
        expect(component.passwordSet).toBe(true);
        expect(component.title).toBe('Password setup complete');
        expect(fixture.nativeElement.textContent).toContain('Your password is set. An administrator must approve your account before you can sign in.');
        expect(fixture.nativeElement.querySelector('app-notice .app-notice')?.classList.contains('app-notice-info')).toBe(true);
        expect(fixture.nativeElement.querySelector('button')?.textContent).toContain('Back to login');
        expect(acceptToken).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('distinguishes committed password setup from failure to accept its browser session', () => {
        const auth = TestBed.inject(AuthService);
        const request = new Subject<ActivationSetupSession | null>();
        vi.spyOn(auth, 'setupPassword').mockReturnValue(request);
        vi.spyOn(auth, 'acceptToken').mockImplementation(() => { throw new Error('browser session storage unavailable'); });
        const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
        fixture.detectChanges();
        component.passwordForm.setValue({password: 'password123', confirmPassword: 'password123'});
        component.submitPassword();
        request.next({status: 'password_set', browser_id: 'browser', generation: 'one', access_token: 'access', token_type: 'Bearer', expires_in: 900});
        request.complete();
        fixture.detectChanges();

        expect(component.passwordSet).toBe(true);
        expect(component.sessionAcceptanceFailed).toBe(true);
        expect(component.error).toBe(false);
        expect(component.setupToken).toBeNull();
        expect(component.title).toBe('Password setup complete');
        expect(fixture.nativeElement.textContent).toContain('Your password is set, but we could not sign you in automatically.');
        expect(fixture.nativeElement.querySelector('form')).toBeNull();
        expect(fixture.nativeElement.querySelector('button')?.textContent).toContain('Continue to sign in');
        expect(navigate).not.toHaveBeenCalled();
    });

    it('does not accept a session or navigate when the API or cookie lock fails', () => {
        const auth = TestBed.inject(AuthService);
        const acceptToken = vi.spyOn(auth, 'acceptToken');
        const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
        const setup = vi.spyOn(auth, 'setupPassword').mockReturnValue(throwError(() => new AuthCookieLockUnavailableError()));
        fixture.detectChanges();
        component.passwordForm.setValue({password: 'password123', confirmPassword: 'password123'});
        component.submitPassword();
        fixture.detectChanges();
        expect(component.error).toBe(true);
        expect(component.lockUnavailable).toBe(true);
        expect(fixture.nativeElement.querySelector('app-notice [role="alert"]')?.textContent).toContain('cannot safely manage sign-in cookies');
        expect(acceptToken).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(localStorage.getItem('zwei.intended-session')).toBeNull();
        setup.mockReturnValue(throwError(() => new Error('setup failed')));
        component.error = false;
        component.submitPassword();
        expect(component.error).toBe(true);
        expect(component.lockUnavailable).toBe(false);
        expect(acceptToken).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('shows an unavailable state when setup fails and rejects fragment values of the wrong shape', () => {
        const auth = TestBed.inject(AuthService);
        vi.spyOn(auth, 'setupPassword').mockReturnValue(throwError(() => new Error('invalid token')));
        fixture.detectChanges();
        component.passwordForm.setValue({password: 'password123', confirmPassword: 'password123'});
        component.submitPassword();
        fixture.detectChanges();
        expect(component.error).toBe(true);
        expect(component.title).toBe('Password setup unavailable');

        history.replaceState(null, '', '/activate#setup=short');
        const invalidFixture = TestBed.createComponent(ActivationComponent);
        invalidFixture.detectChanges();
        expect(invalidFixture.componentInstance.error).toBe(true);
        expect(window.location.hash).toBe('');
        expect(invalidFixture.nativeElement.textContent).toContain('Password setup unavailable');
        expect(invalidFixture.nativeElement.querySelector('form')).toBeNull();
        invalidFixture.destroy();
    });

    it('continues to expose the legacy query-token activation route', () => {
        const auth = TestBed.inject(AuthService);
        const route = TestBed.inject(ActivatedRoute);
        vi.spyOn(route.snapshot.queryParamMap, 'get').mockReturnValue('legacy-token');
        const activate = vi.spyOn(auth, 'activate').mockReturnValue(of({status: 'activated'}));
        fixture.detectChanges();
        expect(activate).toHaveBeenCalledWith('legacy-token');
        expect(component.activated).toBe(true);
        expect(component.setupMode).toBe(false);
    });
});
