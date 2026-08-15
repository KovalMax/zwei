import {waitForAsync, ComponentFixture, TestBed} from '@angular/core/testing';

import {RegistrationComponent} from './registration.component';
import {AppModule} from '../app.module';
import {RegistrationService} from './registration.service';

describe('RegistrationComponent', () => {
    let component: RegistrationComponent;
    let fixture: ComponentFixture<RegistrationComponent>;

    beforeEach(waitForAsync(() => {
        TestBed.configureTestingModule({
            imports: [AppModule]
        })
            .compileComponents();
    }));

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
});
