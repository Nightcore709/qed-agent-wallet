/** A limit measured on the instrument's own history (calibrated) or from a sourced figure (verified); any other status is illustrative. */
export const calibrated = (status: string | undefined): boolean => status === 'verified' || status === 'calibrated'
