import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppModule } from '../../app.module';
import { HomeModule } from '../home.module';
import { CallProfileComponent } from './call-profile.component';

describe('CallProfileComponent', () => {
    let fixture: ComponentFixture<CallProfileComponent>;
    let component: CallProfileComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [AppModule, HomeModule] }).compileComponents();
        fixture = TestBed.createComponent(CallProfileComponent);
        component = fixture.componentInstance;
    });

    it('renders the typed profile and emits the explicit collapse intent', () => {
        const collapse = vi.fn().mockName('collapse');
        component.profile = { name: 'Design team', status: 'Connected', isGroup: true, duration: '01:23', error: false };
        component.collapsible = true;
        component.collapse.subscribe(collapse);

        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('Design team');
        expect(fixture.nativeElement.textContent).toContain('Connected');
        expect(fixture.nativeElement.querySelector('[aria-label="Call duration"]')?.textContent).toContain('01:23');
        fixture.nativeElement.querySelector('button').click();
        expect(collapse).toHaveBeenCalledTimes(1);
    });

    it('keeps minimize treatment aligned for direct calls and groups', () => {
        component.profile = { name: 'Peer', status: 'Connected', error: false };
        component.collapsible = true;
        fixture.detectChanges();
        const direct = fixture.nativeElement.querySelector('.call-direct-collapse-button') as HTMLButtonElement;
        expect(direct).not.toBeNull();
        expect(getComputedStyle(direct).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
        expect(getComputedStyle(direct).borderTopStyle).toBe('solid');
        expect(getComputedStyle(direct).borderRadius).toBe('50%');
        expect(direct.getBoundingClientRect().width).toBe(44);
        expect(direct.getBoundingClientRect().height).toBe(44);
        expect(getComputedStyle(direct).borderRadius).toBe(getComputedStyle(fixture.nativeElement.querySelector('.group-call-collapse-button') || direct).borderRadius);

        component.profile = { name: 'Team', status: 'Connected', isGroup: true, error: false };
        fixture.detectChanges();
        const groupButton = fixture.nativeElement.querySelector('.call-presentation-collapse') as HTMLButtonElement;
        expect(groupButton).toBe(direct);
    });
});
