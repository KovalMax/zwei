import {ComponentFixture, TestBed} from '@angular/core/testing';
import {flushMicrotasks} from '../../testing/vitest-timers';
import { By } from '@angular/platform-browser';
import { MatTooltip } from '@angular/material/tooltip';
import { GroupMember } from './conversation.model';
import { GroupMemberListComponent } from './group-member-list.component';
import { GroupMemberActionIntent } from './group-member-actions.model';
import { AppModule } from '../app.module';
import { HomeModule } from './home.module';

describe('GroupMemberListComponent', () => {
    const member: GroupMember = { userId: 'member-1', displayName: 'Member', role: 'member', visibleFromSequence: 1, joinedAt: '2026-01-01T00:00:00Z' };
    let component: GroupMemberListComponent;
    let fixture: ComponentFixture<GroupMemberListComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [AppModule, HomeModule]}).compileComponents();
    });

    beforeEach(() => {
        fixture = TestBed.createComponent(GroupMemberListComponent);
        component = fixture.componentInstance;
    });

    it('emits typed member intents for available actions', () => {
        component.actionsForMember = () => [{ id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' }];
        const intents: GroupMemberActionIntent[] = [];
        const subscription = component.action.subscribe(intent => intents.push(intent));

        component.requestAction(member, 'make-admin');

        expect(intents).toEqual([{ memberUserID: member.userId, actionID: 'make-admin' }]);
        subscription.unsubscribe();
    });

    it('does not emit an action while loading or for an action not in the current projection', () => {
        component.actionsForMember = () => [{ id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' }];
        const intents: string[] = [];
        const subscription = component.action.subscribe(intent => intents.push(intent.actionID));
        component.loading = true;

        component.requestAction(member, 'make-admin');
        component.loading = false;
        component.requestAction(member, 'remove-member');

        expect(intents).toEqual([]);
        subscription.unsubscribe();
    });

    it('enables keyboard tooltip recovery synchronously and cancels queued displays on blur or scroll', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' }];
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('.member-action-button') as HTMLButtonElement | null;
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);
        tooltip.disabled = true;

        button?.focus();

        expect(tooltip.disabled).toBe(false);
        button?.blur();
        await flushMicrotasks();
        expect(show).not.toHaveBeenCalled();

        button?.focus();
        await flushMicrotasks();
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);

        show.mockClear();
        button?.blur();
        button?.focus();
        component.hideTooltips();
        await flushMicrotasks();
        expect(tooltip.disabled).toBe(true);
        expect(show).not.toHaveBeenCalled();

        show.mockClear();
        button?.blur();
        component.hideTooltips();
        expect(tooltip.disabled).toBe(true);
        button?.focus();
        expect(tooltip.disabled).toBe(false);
        await flushMicrotasks();
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);
    });

    it('re-enables and shows a keyboard tooltip when focus follows hideTooltips', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' }];
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('.member-action-button') as HTMLButtonElement | null;
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);

        component.hideTooltips();
        expect(tooltip.disabled).toBe(true);

        button?.focus();

        expect(tooltip.disabled).toBe(false);
        await flushMicrotasks();
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);
    });

    it('shows the tooltip when keyboard focus follows an explicit tooltip hide', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' }];
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('.member-action-button') as HTMLButtonElement | null;
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);

        component.hideTooltips();

        expect(tooltip.disabled).toBe(true);
        button?.focus();
        expect(tooltip.disabled).toBe(false);
        await flushMicrotasks();
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);
    });

    it('dismisses on member scrolling and reopens only after keyboard focus returns', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' }];
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('.member-action-button') as HTMLButtonElement;
        const list = fixture.nativeElement.querySelector('.group-members') as HTMLUListElement;
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);
        const hide = vi.spyOn(tooltip, 'hide').mockReturnValue(undefined);

        button.focus();
        await flushMicrotasks();
        expect(show).toHaveBeenCalledWith(0);
        show.mockClear();
        list.dispatchEvent(new Event('scroll'));
        fixture.detectChanges();
        expect(tooltip.disabled).toBe(true);
        expect(hide).toHaveBeenCalled();
        await flushMicrotasks();
        expect(show).not.toHaveBeenCalled();

        // A captured scroll in another container must not cancel the queued keyboard show.
        button.blur();
        button.focus();
        const unrelatedScroller = document.createElement('div');
        document.body.appendChild(unrelatedScroller);
        unrelatedScroller.dispatchEvent(new Event('scroll'));
        unrelatedScroller.remove();
        await flushMicrotasks();
        expect(tooltip.disabled).toBe(false);
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);
    });

    it('ignores synthetic mouse entry after scroll until real pointer movement and does not revive outside', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' }];
        fixture.detectChanges();
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);

        component.hideTooltips();
        fixture.detectChanges();
        component.showTooltipOnHover(tooltip);
        expect(tooltip.disabled).toBe(true);
        await flushMicrotasks();
        expect(show).not.toHaveBeenCalled();

        component.restoreHoverOnPointerMove(tooltip);
        expect(tooltip.disabled).toBe(false);
        await flushMicrotasks();
        expect(show).toHaveBeenCalledWith(0);

        show.mockClear();
        component.hideTooltips();
        document.dispatchEvent(new PointerEvent('pointermove'));
        await flushMicrotasks();
        expect(show).not.toHaveBeenCalled();
    });
});
