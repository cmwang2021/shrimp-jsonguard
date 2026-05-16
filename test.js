const jsonguard = require('./jsonguard');
const brokenJson = '```json\n{"name": "Shrimp Clan", "status": "Hero",';
console.log("Original:", brokenJson);
console.log("Fixed:", jsonguard(brokenJson));
