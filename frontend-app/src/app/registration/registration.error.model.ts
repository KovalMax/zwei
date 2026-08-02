export interface RegistrationErrorResponse {
    status: number;
    invalidParams: InvalidParam[];
    error?: {error?: string};
}

export interface InvalidParam {
    name: string;
    reason: string;
}

export interface InvalidParamMap {
    [name: string]: string;
}
