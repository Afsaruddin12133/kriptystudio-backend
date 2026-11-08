// Initial site content, inserted once on first start so the website looks the same until an admin edits it.
export const defaultFaqs = [
  ["What services does Kripty Studio offer?", "We offer end-to-end creative services, including UI/UX design, website and app development, and animation to help brands bring their digital ideas to life."],
  ["Can you handle a project from design to development?", "Yes. Our team covers the full journey — research, UI/UX design, frontend development and motion — so you get one consistent partner from concept to launch."],
  ["How much does a project cost?", "Every project is scoped individually. Most engagements fall between $1K and $50K depending on complexity, timeline and deliverables. Share your brief and we’ll send a tailored quote."],
  ["How long does a project take to complete?", "Landing pages usually take 2–3 weeks, while full platforms such as casinos or sportsbooks take 6–12 weeks. We agree on milestones before we start."],
  ["What is your process for starting a new project?", "We start with a discovery call, then define scope, timeline and budget. After a kickoff we move through wireframes, visual design, development and handoff."],
  ["How many revisions do you provide?", "Each design phase includes two rounds of revisions. Additional rounds can be added whenever you need them."],
  ["How do payments work?", "We typically work with a 50% upfront payment and the remainder on delivery. Larger projects can be split into milestone-based payments. We accept bank transfer and crypto."],
  ["What do you need from us to get started?", "A short brief with your goals, target audience, references you like and any existing brand assets. We’ll handle the rest."],
].map(([q, a], i) => ({ q, a, published: true, order: i }));

// Seeded works point at images shipped with the frontend (/images/...); uploads live under /uploads/.
export const defaultWorks = Array.from({ length: 14 }, (_, i) => ({
  src: `/images/work-${i + 1}.png`,
  alt: `Kripty Studio iGaming platform UI design — case study ${i + 1}`,
  published: true,
  order: i,
}));

export const defaultTestimonials = [
  ["Snoppy", "Founder of Sports Degens", "/images/avatar-snoppy.png", "Kripty Studio understood our vision from day one and turned it into a product our community loves. Fast, reliable and genuinely creative."],
  ["Tommy", "CEO of KrushGG", "/images/avatar-tommy.png", "Great experience working with Kripty Studio. The team paid close attention to the details and created a design that felt both modern and easy to use. They were open to suggestions, understood our requirements, and made the whole collaboration feel straightforward. I’d be happy to work with them again."],
  ["High Stakes Hugs", "Co-founder of GETDGN", "/images/avatar-hugs.png", "The team did a great job bringing our ideas to life. They took the time to understand our brand and delivered visuals that felt consistent, polished, and well thought out. What stood out most was their attention to detail and professional approach throughout the project. Overall, a very positive experience."],
].map(([name, role, avatar, quote], i) => ({ name, role, avatar, video: null, quote, published: true, order: i }));
