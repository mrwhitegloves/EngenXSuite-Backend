// The starting lists the seed writes into an EMPTY collection (Master Prompt Sections 10, 11).
// After that they are managed in Settings; changing this file does not change a seeded database.

// The industrial sales pipeline, in board order. `probability` is the suggested chance of
// winning when a lead enters the stage; it is a starting value to tune in Settings.
export const DEFAULT_PIPELINE_STAGES = [
  { key: 'lead', name: 'Lead', type: 'open', probability: 5 },
  { key: 'qualified', name: 'Qualified', type: 'open', probability: 10 },
  { key: 'discovery', name: 'Discovery', type: 'open', probability: 15 },
  { key: 'plant_visit', name: 'Plant Visit', type: 'open', probability: 20 },
  { key: 'requirement_identified', name: 'Requirement Identified', type: 'open', probability: 30 },
  { key: 'technical_study', name: 'DMA / Technical Study', type: 'open', probability: 35 },
  { key: 'solution_designing', name: 'Solution Designing', type: 'open', probability: 40 },
  { key: 'proposal', name: 'Proposal', type: 'open', probability: 50 },
  { key: 'technical_discussion', name: 'Technical Discussion', type: 'open', probability: 55 },
  { key: 'pilot_poc', name: 'Pilot / PoC', type: 'open', probability: 65 },
  { key: 'commercial_negotiation', name: 'Commercial Negotiation', type: 'open', probability: 75 },
  { key: 'management_approval', name: 'Management Approval', type: 'open', probability: 85 },
  { key: 'po_expected', name: 'PO Expected', type: 'open', probability: 95 },
  { key: 'won', name: 'Won', type: 'won', probability: 100 },
  { key: 'lost', name: 'Lost', type: 'lost', probability: 0 },
];

export const DEFAULT_SOLUTION_CATEGORIES = [
  'Digital Twin',
  'Machine Monitoring',
  'OEE',
  'Predictive Maintenance',
  'Energy Monitoring',
  'Digital Traceability',
  'Computer Vision',
  'Quality Digitization',
  'Production Monitoring',
  'Industrial IoT',
  'AI/ML',
  'Digital Manufacturing',
  'Plant Digitization',
  'PLC/SCADA Integration',
  'Engineering Solutions',
  'Custom Automation',
];
