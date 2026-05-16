function jsonguard(input) {
    let clean = input.replace(/```json/g, '').replace(/```/g, '').trim();
    clean = clean.replace(/,\s*$/, ""); 
    let openCount = (clean.match(/{/g) || []).length;
    let closeCount = (clean.match(/}/g) || []).length;
    if (openCount > closeCount) {
        clean += '}'.repeat(openCount - closeCount);
    }
    clean = clean.replace(/,(\s*[}\]])/g, '');
    try {
        return JSON.parse(clean);
    } catch (e) {
        return { error: "Repair failed", raw: clean, diag: e.message };
    }
}
module.exports = jsonguard;
