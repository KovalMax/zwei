import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppModule } from '../../app.module';
import { HomeModule } from '../home.module';
import { CallIconActionsComponent } from './call-icon-actions.component';

describe('CallIconActionsComponent', () => {
    let fixture: ComponentFixture<CallIconActionsComponent>;
    let component: CallIconActionsComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [AppModule, HomeModule] }).compileComponents();
        fixture = TestBed.createComponent(CallIconActionsComponent);
        component = fixture.componentInstance;
    });

    it('keeps mute and screen-share actions together with accessible labels', () => {
        const action = vi.fn().mockName('action');
        component.actions = [
            { id: 'mute', label: 'Mute microphone', active: false, disabled: false },
            { id: 'screen-share', label: 'Share screen', active: false, disabled: false },
        ];
        component.action.subscribe(action);
        fixture.detectChanges();

        const buttons = fixture.nativeElement.querySelectorAll('.call-presentation-icon-actions button');
        expect(buttons.length).toBe(2);
        expect(buttons[0].getAttribute('aria-label')).toBe('Mute microphone');
        expect(buttons[1].getAttribute('aria-label')).toBe('Share screen');
        buttons[0].click();
        buttons[1].click();
        expect(action).toHaveBeenCalledWith('mute');
        expect(action).toHaveBeenCalledWith('screen-share');
    });

    it('keeps group action buttons square by default and supports a round direct-call appearance', () => {
        component.actions = [{ id: 'mute', label: 'Mute microphone', active: false, disabled: false }];
        fixture.detectChanges();
        let button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
        expect(button.classList).toContain('call-action-square');
        fixture.componentRef.setInput('appearance', 'round');
        fixture.detectChanges();
        button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
        expect(button.classList).toContain('call-action-round');
    });
});
