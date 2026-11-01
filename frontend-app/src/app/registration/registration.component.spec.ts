import {ComponentFixture, TestBed} from '@angular/core/testing';
import {NgZone} from '@angular/core';

import {RegistrationComponent} from './registration.component';
import {AppModule} from '../app.module';
import {RegistrationService} from './registration.service';
import {AuthService} from '../auth/auth.service';
import {Router} from '@angular/router';
import {of, Subject, throwError} from 'rxjs';

describe('RegistrationComponent', () => {
    let component: RegistrationComponent;
    let fixture: ComponentFixture<RegistrationComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule]
        })
            .compileComponents();
    });

    beforeEach(() => {
        fixture = TestBed.createComponent(RegistrationComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('builds a fresh form for each registration visit', () => {
        const service = TestBed.inject(RegistrationService);
        const first = service.buildForm();
        first.controls.email.setValue('previous@example.test');

        const second = service.buildForm();
        expect(second).not.toBe(first);
        expect(second.controls.email.value).toBe('');
    });

    it('routes a pending registration without accepting a session', () => {
        const service = TestBed.inject(RegistrationService);
        const auth = TestBed.inject(AuthService);
        const accept = vi.spyOn(auth, 'acceptToken');
        const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
        vi.spyOn(service, 'registration').mockReturnValue(of({status: 'pending'}));
        component.registrationForm.setValue({email: 'user@example.test', password: 'password123', confirmPassword: 'password123', firstName: 'First', lastName: 'Last', nickName: 'User'});
        component.onSubmit();
        expect(accept).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith(['pending']);
    });

    it('accepts an invitation session with its selectors and navigates home', () => {
        const service = TestBed.inject(RegistrationService);
        const auth = TestBed.inject(AuthService);
        const accept = vi.spyOn(auth, 'acceptToken');
        vi.spyOn(auth, 'defaultAuthenticatedRoute').mockReturnValue('home');
        const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
        const session = {browser_id: 'browser', generation: 'generation', access_token: `header.${btoa(JSON.stringify({sub: 'user'}))}.signature`, token_type: 'Bearer', expires_in: 300};
        vi.spyOn(service, 'registration').mockReturnValue(of(session));
        component.registrationForm.setValue({email: 'user@example.test', password: 'password123', confirmPassword: 'password123', firstName: 'First', lastName: 'Last', nickName: 'User'});
        component.onSubmit();
        expect(accept).toHaveBeenCalledWith(session);
        expect(navigate).toHaveBeenCalledWith(['home']);
    });

    it('keeps registration failures visible as an accessible persistent notice', () => {
        component.errorMessage = 'An account with this email already exists. Try signing in instead.';
        fixture.detectChanges();
        const notice = fixture.nativeElement.querySelector('app-notice [role="alert"]') as HTMLElement;
        expect(notice.textContent).toContain('Try signing in instead.');
    });

    it('clears loading and reports duplicate and invitation errors from failed submissions', () => {
        const service = TestBed.inject(RegistrationService);
        const registrationForm = {email: 'user@example.test', password: 'password123', confirmPassword: 'password123', firstName: 'First', lastName: 'Last', nickName: 'User'};
        component.registrationForm.setValue(registrationForm);
        const registration = vi.spyOn(service, 'registration').mockReturnValue(throwError(() => ({status: 409, invalidParams: []})));

        component.onSubmit();

        expect(component.isLoading).toBe(false);
        expect(component.errorMessage).toBe('An account with this email already exists. Try signing in instead.');
        component.registrationForm.setValue(registrationForm);
        registration.mockReturnValue(throwError(() => ({status: 400, invalidParams: [], error: {error: 'invalid invitation code'}})));

        component.onSubmit();

        expect(component.isLoading).toBe(false);
        expect(component.errorMessage).toBe('invalid invitation code');
        fixture.detectChanges();
        const notice = fixture.nativeElement.querySelector('app-notice [role="alert"]') as HTMLElement;
        expect(notice.textContent).toContain('invalid invitation code');
    });

    it('renders a failed registration delivered outside Angular without manual change detection', async () => {
        const service = TestBed.inject(RegistrationService);
        const failedRequest = new Subject<never>();
        vi.spyOn(service, 'registration').mockReturnValue(failedRequest);
        component.registrationForm.setValue({email: 'user@example.test', password: 'password123', confirmPassword: 'password123', firstName: 'First', lastName: 'Last', nickName: 'User'});
        component.onSubmit();
        fixture.detectChanges();

        TestBed.inject(NgZone).runOutsideAngular(() => failedRequest.error({status: 409, invalidParams: []}));
        await fixture.whenStable();

        const notice = fixture.nativeElement.querySelector('app-notice [role="alert"]') as HTMLElement;
        expect(notice.textContent).toContain('An account with this email already exists. Try signing in instead.');
    });
});
