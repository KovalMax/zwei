import {ComponentFixture, TestBed} from '@angular/core/testing';

import {RegistrationComponent} from './registration.component';
import {AppModule} from '../app.module';
import {RegistrationService} from './registration.service';
import {AuthService} from '../auth/auth.service';
import {Router} from '@angular/router';
import {of} from 'rxjs';

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
});
