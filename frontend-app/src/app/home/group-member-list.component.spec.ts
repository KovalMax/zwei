import {ComponentFixture, TestBed} from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatTooltip } from '@angular/material/tooltip';
import { GroupMember } from './conversation.model';
import { GroupMemberListComponent } from './group-member-list.component';
import { GroupMemberActionIntent } from './group-member-actions.model';
import { AppModule } from '../app.module';
import { HomeModule } from './home.module';

async function flushTooltipFrame(): Promise<void> {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

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
        await flushTooltipFrame();
        expect(show).not.toHaveBeenCalled();

        button?.focus();
        await flushTooltipFrame();
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);

        show.mockClear();
        button?.blur();
        button?.focus();
        component.hideTooltips();
        await flushTooltipFrame();
        expect(tooltip.disabled).toBe(true);
        expect(show).not.toHaveBeenCalled();

        show.mockClear();
        button?.blur();
        component.hideTooltips();
        expect(tooltip.disabled).toBe(true);
        button?.focus();
        expect(tooltip.disabled).toBe(false);
        await flushTooltipFrame();
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
        await flushTooltipFrame();
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
        await flushTooltipFrame();
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
        await flushTooltipFrame();
        expect(show).toHaveBeenCalledWith(0);
        show.mockClear();
        list.dispatchEvent(new Event('scroll'));
        fixture.detectChanges();
        expect(tooltip.disabled).toBe(true);
        expect(hide).toHaveBeenCalled();
        await flushTooltipFrame();
        expect(show).not.toHaveBeenCalled();

        // A captured scroll in another container must not cancel the queued keyboard show.
        button.blur();
        button.focus();
        const unrelatedScroller = document.createElement('div');
        document.body.appendChild(unrelatedScroller);
        unrelatedScroller.dispatchEvent(new Event('scroll'));
        unrelatedScroller.remove();
        await flushTooltipFrame();
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
        await flushTooltipFrame();
        expect(show).not.toHaveBeenCalled();

        component.restoreHoverOnPointerMove(tooltip);
        expect(tooltip.disabled).toBe(false);
        await flushTooltipFrame();
        expect(show).toHaveBeenCalledWith(0);

        show.mockClear();
        component.hideTooltips();
        document.dispatchEvent(new PointerEvent('pointermove'));
        await flushTooltipFrame();
        expect(show).not.toHaveBeenCalled();
    });

    it('re-enables the tooltip before a real hover after pointer movement clears scroll suppression', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' }];
        fixture.detectChanges();
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);

        component.hideTooltips();
        fixture.detectChanges();
        expect(tooltip.disabled).toBe(true);

        document.dispatchEvent(new PointerEvent('pointermove'));
        expect(component.isTooltipDisabled(tooltip)).toBe(false);
        component.showTooltipOnHover(tooltip);

        expect(tooltip.disabled).toBe(false);
        await flushTooltipFrame();
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);
    });

    it('cancels a queued tooltip display when the component is destroyed', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' }];
        fixture.detectChanges();
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);

        component.showTooltipOnFocus(tooltip);
        fixture.destroy();
        await flushTooltipFrame();

        expect(show).not.toHaveBeenCalled();
    });

    it('cancels a queued hover tooltip when the pointer leaves before the next frame', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' }];
        fixture.detectChanges();
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);

        component.showTooltipOnHover(tooltip);
        component.hideTooltipOnLeave(tooltip);
        await flushTooltipFrame();

        expect(show).not.toHaveBeenCalled();
    });

    it('restores the focused tooltip when hover intent ends before the next frame', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' }];
        fixture.detectChanges();
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);

        component.showTooltipOnFocus(tooltip);
        component.showTooltipOnHover(tooltip);
        component.hideTooltipOnLeave(tooltip);
        await flushTooltipFrame();

        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);
    });

    it('keeps the tooltip visible on blur while the pointer remains over the action', async () => {
        component.members = [member];
        component.actionsForMember = () => [{ id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' }];
        fixture.detectChanges();
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = vi.spyOn(tooltip, 'show').mockReturnValue(undefined);
        const hide = vi.spyOn(tooltip, 'hide').mockReturnValue(undefined);

        component.showTooltipOnFocus(tooltip);
        component.showTooltipOnHover(tooltip);
        component.hideTooltipOnBlur(tooltip);
        await flushTooltipFrame();

        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith(0);
        expect(hide).not.toHaveBeenCalled();
    });

    it('preserves a different focused tooltip when a hovered action is left', async () => {
        component.members = [member];
        component.actionsForMember = () => [
            { id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' },
            { id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' },
        ];
        fixture.detectChanges();
        const tooltips = fixture.debugElement.queryAll(By.directive(MatTooltip)).map(element => element.injector.get(MatTooltip));
        const makeAdminShow = vi.spyOn(tooltips[0], 'show').mockReturnValue(undefined);
        const removeShow = vi.spyOn(tooltips[1], 'show').mockReturnValue(undefined);

        component.showTooltipOnHover(tooltips[0]);
        component.showTooltipOnFocus(tooltips[1]);
        component.hideTooltipOnLeave(tooltips[0]);
        await flushTooltipFrame();

        expect(makeAdminShow).not.toHaveBeenCalled();
        expect(removeShow).toHaveBeenCalledTimes(1);
        expect(removeShow).toHaveBeenCalledWith(0);
    });

    it('preserves a different hovered tooltip when focus leaves the active action', async () => {
        component.members = [member];
        component.actionsForMember = () => [
            { id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' },
            { id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' },
        ];
        fixture.detectChanges();
        const tooltips = fixture.debugElement.queryAll(By.directive(MatTooltip)).map(element => element.injector.get(MatTooltip));
        const makeAdminShow = vi.spyOn(tooltips[0], 'show').mockReturnValue(undefined);
        const removeShow = vi.spyOn(tooltips[1], 'show').mockReturnValue(undefined);

        component.showTooltipOnHover(tooltips[0]);
        component.showTooltipOnFocus(tooltips[1]);
        component.hideTooltipOnBlur(tooltips[1]);
        await flushTooltipFrame();

        expect(makeAdminShow).toHaveBeenCalledTimes(1);
        expect(makeAdminShow).toHaveBeenCalledWith(0);
        expect(removeShow).not.toHaveBeenCalled();
    });

    it('preserves a newer hover when the previous action leaves afterward', async () => {
        component.members = [member];
        component.actionsForMember = () => [
            { id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' },
            { id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' },
        ];
        fixture.detectChanges();
        const tooltips = fixture.debugElement.queryAll(By.directive(MatTooltip)).map(element => element.injector.get(MatTooltip));
        const makeAdminShow = vi.spyOn(tooltips[0], 'show').mockReturnValue(undefined);
        const removeShow = vi.spyOn(tooltips[1], 'show').mockReturnValue(undefined);

        component.showTooltipOnHover(tooltips[0]);
        component.showTooltipOnHover(tooltips[1]);
        component.hideTooltipOnLeave(tooltips[0]);
        await flushTooltipFrame();

        expect(makeAdminShow).not.toHaveBeenCalled();
        expect(removeShow).toHaveBeenCalledTimes(1);
        expect(removeShow).toHaveBeenCalledWith(0);
    });

    it('does not show a queued tooltip after its action directive is removed', async () => {
        component.members = [member];
        component.actionsForMember = () => [
            { id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge' },
            { id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' },
        ];
        fixture.detectChanges();
        const removedTooltip = fixture.debugElement.queryAll(By.directive(MatTooltip))[0].injector.get(MatTooltip);
        const show = vi.spyOn(removedTooltip, 'show').mockReturnValue(undefined);

        component.showTooltipOnFocus(removedTooltip);
        component.actionsForMember = () => [{ id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member', icon: 'badge' }];
        fixture.detectChanges();
        await flushTooltipFrame();

        expect(show).not.toHaveBeenCalled();
    });
});
