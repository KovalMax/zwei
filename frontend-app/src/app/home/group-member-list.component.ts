import {DOCUMENT} from '@angular/common';
import {ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, EventEmitter, HostListener, Inject, Input, OnChanges, Output, QueryList, Renderer2, SimpleChanges, ViewChild, ViewChildren} from '@angular/core';
import {MatTooltip} from '@angular/material/tooltip';
import {GroupMember} from './conversation.model';
import {GroupMemberAction, GroupMemberActionID, GroupMemberActionIntent} from './group-member-actions.model';

@Component({
    selector: 'app-group-member-list',
    standalone: false,
    templateUrl: './group-member-list.component.html',
    styleUrls: ['./group-member-list.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupMemberListComponent implements OnChanges {
    @ViewChild('memberScroller') private memberScroller?: ElementRef<HTMLUListElement>;
    @ViewChildren(MatTooltip) private tooltips?: QueryList<MatTooltip>;
    private suppressHoverAfterScroll = false;
    private focusedTooltip?: MatTooltip;
    private hoveredTooltip?: MatTooltip;
    private activeTooltip?: MatTooltip;
    private queuedShowGeneration = 0;
    private queuedShowFrame?: number;

    public constructor(
        private readonly changeDetector: ChangeDetectorRef,
        renderer: Renderer2,
        @Inject(DOCUMENT) document: Document,
        destroyRef: DestroyRef,
    ) {
        destroyRef.onDestroy(renderer.listen(document, 'scroll', event => {
            const target = event.target;
            // Captured scrolls also include unrelated containers (including CDK overlays).
            // Only movement of the list or its settings panel can displace these targets.
            if (target === document || target === document.documentElement || target === document.body ||
                (target instanceof Element && (target === this.memberScroller?.nativeElement || target.closest('.group-settings-panel') === target))) {
                this.hideTooltips();
            }
        }, {capture: true, passive: true}));
        destroyRef.onDestroy(() => {
            this.cancelQueuedShow();
            this.focusedTooltip = undefined;
            this.hoveredTooltip = undefined;
            this.activeTooltip = undefined;
        });
    }

    @Input({required: true}) public members: readonly GroupMember[] = [];
    @Input({required: true}) public actionsForMember: (member: GroupMember) => readonly GroupMemberAction[] = () => [];
    @Input() public loading = false;
    @Output() public readonly action = new EventEmitter<GroupMemberActionIntent>();

    public ngOnChanges(changes: SimpleChanges): void {
        if (changes['members'] && this.memberScroller) this.memberScroller.nativeElement.style.maxHeight = '';
    }

    public trackMember(_index: number, member: GroupMember): string { return member.userId; }
    public trackAction(_index: number, action: GroupMemberAction): GroupMemberActionID { return action.id; }
    public isTooltipDisabled(tooltip: MatTooltip): boolean { return this.suppressHoverAfterScroll && this.focusedTooltip !== tooltip; }
    public showTooltipOnFocus(tooltip: MatTooltip): void {
        this.suppressHoverAfterScroll = false;
        this.focusedTooltip = tooltip;
        this.activateTooltip(tooltip);
        tooltip.disabled = false;
        this.changeDetector.markForCheck();
        this.scheduleTooltipShow(tooltip, () => this.focusedTooltip === tooltip && this.activeTooltip === tooltip && !this.suppressHoverAfterScroll);
    }
    public showTooltipOnHover(tooltip: MatTooltip): void {
        // Scrolling can move a different button underneath a stationary pointer
        // and dispatch mouseenter. Wait for real pointer movement before treating
        // that synthetic entry as renewed hover intent.
        if (this.suppressHoverAfterScroll) return;
        this.hoveredTooltip = tooltip;
        this.activateTooltip(tooltip);
        // Scroll dismissal disables every tooltip imperatively. A real pointer
        // re-entry must re-enable this instance before Material handles hover;
        // relying on the bound input's next change-detection pass can lose the
        // mouseenter that should reopen the overlay.
        tooltip.disabled = false;
        this.changeDetector.markForCheck();
        this.scheduleTooltipShow(tooltip, () => this.activeTooltip === tooltip && this.hoveredTooltip === tooltip && !this.suppressHoverAfterScroll);
    }
    public hideTooltipOnBlur(tooltip: MatTooltip): void {
        if (this.focusedTooltip === tooltip) this.focusedTooltip = undefined;
        const remainingTooltip = this.focusedTooltip ?? (!this.suppressHoverAfterScroll ? this.hoveredTooltip : undefined);
        if (remainingTooltip) {
            this.activeTooltip = remainingTooltip;
            remainingTooltip.disabled = false;
            this.changeDetector.markForCheck();
            this.scheduleTooltipShow(remainingTooltip, () => this.activeTooltip === remainingTooltip &&
                (this.focusedTooltip === remainingTooltip || this.hoveredTooltip === remainingTooltip) && !this.suppressHoverAfterScroll);
            if (tooltip !== remainingTooltip) tooltip.hide(0);
        } else {
            if (this.activeTooltip === tooltip) this.activeTooltip = undefined;
            this.cancelQueuedShow();
            tooltip.hide(0);
        }
        this.changeDetector.markForCheck();
    }
    public hideTooltipOnLeave(tooltip: MatTooltip): void {
        if (this.hoveredTooltip === tooltip) this.hoveredTooltip = undefined;
        tooltip.hide(0);
        const remainingTooltip = this.focusedTooltip ?? (!this.suppressHoverAfterScroll ? this.hoveredTooltip : undefined);
        if (remainingTooltip) {
            this.activeTooltip = remainingTooltip;
            remainingTooltip.disabled = false;
            this.changeDetector.markForCheck();
            this.scheduleTooltipShow(remainingTooltip, () => this.activeTooltip === remainingTooltip &&
                (this.focusedTooltip === remainingTooltip || this.hoveredTooltip === remainingTooltip) && !this.suppressHoverAfterScroll);
            return;
        }
        if (this.activeTooltip === tooltip) this.activeTooltip = undefined;
        this.cancelQueuedShow();
    }
    public restoreHoverOnPointerMove(tooltip: MatTooltip): void {
        if (!this.suppressHoverAfterScroll) return;
        this.suppressHoverAfterScroll = false;
        this.hoveredTooltip = tooltip;
        this.activateTooltip(tooltip);
        tooltip.disabled = false;
        this.changeDetector.markForCheck();
        this.scheduleTooltipShow(tooltip, () => this.activeTooltip === tooltip && this.hoveredTooltip === tooltip && !this.suppressHoverAfterScroll);
    }
    public hideTooltips(): void {
        this.suppressHoverAfterScroll = true;
        this.focusedTooltip = undefined;
        this.hoveredTooltip = undefined;
        this.cancelQueuedShow();
        const activeTooltip = this.activeTooltip;
        this.activeTooltip = undefined;
        if (activeTooltip) {
            activeTooltip.disabled = true;
            activeTooltip.hide(0);
        }
        this.tooltips?.forEach(tooltip => {
            tooltip.disabled = true;
            tooltip.hide(0);
        });
        this.changeDetector.markForCheck();
    }

    public onMemberListScroll(event: Event): void {
        this.hideTooltips();
        if (event.currentTarget instanceof HTMLElement) this.alignFirstVisibleMember(event.currentTarget);
    }

    private activateTooltip(tooltip: MatTooltip): void {
        if (this.activeTooltip && this.activeTooltip !== tooltip) this.activeTooltip.hide(0);
        this.activeTooltip = tooltip;
    }

    private scheduleTooltipShow(tooltip: MatTooltip, isCurrentIntent: () => boolean): void {
        if (this.queuedShowFrame !== undefined) cancelAnimationFrame(this.queuedShowFrame);
        const generation = ++this.queuedShowGeneration;
        this.queuedShowFrame = requestAnimationFrame(() => {
            this.queuedShowFrame = undefined;
            if (generation === this.queuedShowGeneration && isCurrentIntent() && this.tooltips?.toArray().includes(tooltip)) tooltip.show(0);
        });
    }

    private cancelQueuedShow(): void {
        this.queuedShowGeneration++;
        if (this.queuedShowFrame === undefined) return;
        cancelAnimationFrame(this.queuedShowFrame);
        this.queuedShowFrame = undefined;
    }

    private alignFirstVisibleMember(scroller: HTMLElement): void {
        const paddingBottom = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
        if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - paddingBottom - 1) return;
        const listRect = scroller.getBoundingClientRect();
        const firstClippedRow = Array.from(scroller.children).find((child): child is HTMLElement => {
            if (!(child instanceof HTMLElement)) return false;
            const rect = child.getBoundingClientRect();
            return rect.top < listRect.top - 1 && rect.bottom > listRect.top + 1;
        });
        if (!firstClippedRow) return;

        const rowOffset = scroller.scrollTop + firstClippedRow.getBoundingClientRect().top - listRect.top;
        const alignedHeight = Math.ceil(scroller.scrollHeight - rowOffset);
        const settingsPanel = scroller.closest<HTMLElement>('.group-settings-panel');
        const availableHeight = Math.floor(Math.min(window.innerHeight, settingsPanel?.getBoundingClientRect().bottom ?? window.innerHeight) - listRect.top);
        const nextHeight = Math.min(alignedHeight, availableHeight);
        if (nextHeight <= scroller.clientHeight + 1) return;

        scroller.style.maxHeight = `${nextHeight}px`;
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }

    @HostListener('document:pointermove', ['$event'])
    public restoreHoverAfterPointerLeavesActions(event: PointerEvent): void {
        if (!this.suppressHoverAfterScroll || (event.target instanceof Element && event.target.closest('.member-action-button'))) return;
        this.suppressHoverAfterScroll = false;
        this.changeDetector.markForCheck();
    }

    @HostListener('window:resize')
    public hideTooltipsWhenTargetsMove(): void {
        this.hideTooltips();
        if (this.memberScroller) this.memberScroller.nativeElement.style.maxHeight = '';
    }

    public requestAction(member: GroupMember, actionID: GroupMemberActionID): void {
        if (this.loading || !this.actionsForMember(member).some(action => action.id === actionID)) return;
        this.action.emit({memberUserID: member.userId, actionID});
    }
}
