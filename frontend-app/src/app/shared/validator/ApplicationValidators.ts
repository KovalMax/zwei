import {AbstractControl, ValidationErrors, ValidatorFn} from '@angular/forms';

export class ApplicationValidators {
    static valuesAreEqual(compare: string, compareAgainst: string): ValidatorFn {
        return (group: AbstractControl): ValidationErrors | null => {
            const compareControl: AbstractControl | null = group.get(compare);
            const compareAgainstControl: AbstractControl | null = group.get(compareAgainst);
            if (!compareControl || !compareAgainstControl) {
                return null;
            }
            if (!compareControl.value || !compareAgainstControl.value) {
                return null;
            }
            return compareControl.value === compareAgainstControl.value ? null : {mustMatch: true};
        };
    }
}
