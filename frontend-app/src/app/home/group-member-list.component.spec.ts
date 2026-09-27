import {fakeAsync, flushMicrotasks, waitForAsync, ComponentFixture, TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {MatTooltip} from '@angular/material/tooltip';
import {GroupMember} from './conversation.model';
import {GroupMemberListComponent} from './group-member-list.component';
import {GroupMemberActionIntent} from './group-member-actions.model';
import {AppModule} from '../app.module';
import {HomeModule} from './home.module';

describe('GroupMemberListComponent', () => {
    const member: GroupMember = {userId: 'member-1', displayName: 'Member', email: 'member@example.test', role: 'member', visibleFromSequence: 1, joinedAt: '2026-01-01T00:00:00Z'};
    let component: GroupMemberListComponent;
    let fixture: ComponentFixture<GroupMemberListComponent>;

    beforeEach(waitForAsync(() => {
        TestBed.configureTestingModule({imports: [AppModule, HomeModule]}).compileComponents();
    }));

    beforeEach(() => {
        fixture = TestBed.createComponent(GroupMemberListComponent);
        component = fixture.componentInstance;
    });

    it('emits typed member intents for available actions', () => {
        component.actionsForMember = () => [{id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge'}];
        const intents: GroupMemberActionIntent[] = [];
        const subscription = component.action.subscribe(intent => intents.push(intent));

        component.requestAction(member, 'make-admin');

        expect(intents).toEqual([{memberUserID: member.userId, actionID: 'make-admin'}]);
        subscription.unsubscribe();
    });

    it('does not emit an action while loading or for an action not in the current projection', () => {
        component.actionsForMember = () => [{id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge'}];
        const intents: string[] = [];
        const subscription = component.action.subscribe(intent => intents.push(intent.actionID));
        component.loading = true;

        component.requestAction(member, 'make-admin');
        component.loading = false;
        component.requestAction(member, 'remove-member');

        expect(intents).toEqual([]);
        subscription.unsubscribe();
    });

    it('enables keyboard tooltip recovery synchronously and cancels queued displays on blur or scroll', fakeAsync(() => {
        component.members = [member];
        component.actionsForMember = () => [{id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge'}];
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('.member-action-button') as HTMLButtonElement | null;
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = spyOn(tooltip, 'show');
        tooltip.disabled = true;

        button?.focus();

        expect(tooltip.disabled).toBe(false);
        button?.blur();
        flushMicrotasks();
        expect(show).not.toHaveBeenCalled();

        button?.focus();
        flushMicrotasks();
        expect(show).toHaveBeenCalledOnceWith(0);

        show.calls.reset();
        button?.blur();
        button?.focus();
        component.hideTooltips();
        flushMicrotasks();
        expect(tooltip.disabled).toBe(true);
        expect(show).not.toHaveBeenCalled();

        show.calls.reset();
        button?.blur();
        component.hideTooltips();
        expect(tooltip.disabled).toBe(true);
        button?.focus();
        expect(tooltip.disabled).toBe(false);
        flushMicrotasks();
        expect(show).toHaveBeenCalledOnceWith(0);
    }));

    it('re-enables and shows a keyboard tooltip when focus follows hideTooltips', fakeAsync(() => {
        component.members = [member];
        component.actionsForMember = () => [{id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge'}];
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('.member-action-button') as HTMLButtonElement | null;
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = spyOn(tooltip, 'show');

        component.hideTooltips();
        expect(tooltip.disabled).toBeTrue();

        button?.focus();

        expect(tooltip.disabled).toBeFalse();
        flushMicrotasks();
        expect(show).toHaveBeenCalledOnceWith(0);
    }));

    it('shows the tooltip when keyboard focus follows an explicit tooltip hide', fakeAsync(() => {
        component.members = [member];
        component.actionsForMember = () => [{id: 'make-admin', label: 'Make admin', ariaLabel: 'Make Member an admin', icon: 'badge'}];
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('.member-action-button') as HTMLButtonElement | null;
        const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
        const show = spyOn(tooltip, 'show');

        component.hideTooltips();

        expect(tooltip.disabled).toBeTrue();
        button?.focus();
        expect(tooltip.disabled).toBeFalse();
        flushMicrotasks();
        expect(show).toHaveBeenCalledOnceWith(0);
    }));
});
