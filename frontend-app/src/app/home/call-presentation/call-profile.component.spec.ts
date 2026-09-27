import {ComponentFixture, TestBed} from '@angular/core/testing';
import {AppModule} from '../../app.module';
import {HomeModule} from '../home.module';
import {CallProfileComponent} from './call-profile.component';

describe('CallProfileComponent', () => {
    let fixture: ComponentFixture<CallProfileComponent>;
    let component: CallProfileComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [AppModule, HomeModule]}).compileComponents();
        fixture = TestBed.createComponent(CallProfileComponent);
        component = fixture.componentInstance;
    });

    it('renders the typed profile and emits the explicit collapse intent', () => {
        const collapse = jasmine.createSpy('collapse');
        component.profile = {name: 'Design team', status: 'Connected', isGroup: true, duration: '01:23', error: false};
        component.collapsible = true;
        component.collapse.subscribe(collapse);

        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('Design team');
        expect(fixture.nativeElement.textContent).toContain('Connected');
        expect(fixture.nativeElement.querySelector('[aria-label="Call duration"]')?.textContent).toContain('01:23');
        fixture.nativeElement.querySelector('button').click();
        expect(collapse).toHaveBeenCalledTimes(1);
    });
});
