/** Retain the violated oracle identity alongside the original assertion details. */
export function assertSimulationProperty(name, assertion) {
    try {
        assertion();
    } catch (error) {
        error.property = name;
        throw error;
    }
}
