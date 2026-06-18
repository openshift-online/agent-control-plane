---
name: ui-audit
description: >
  Comprehensive workflow to audit the `ambient-ui` component's ui & ux. Use after
  any changes are made to the `ambient-ui` user interface.
---

# Workflow

Follow this workflow precisely and exactly.

## Step 1: Expert Audit

Launch 15 subagents with the following personas to perform
a comprehensive audit from their perspectives. They should
look wholistically at the ui/ux/user journey, but you should
point out which changes were recently done so that they can 
provide specific feedback about new changes, but in the context
of the app as a whole.

Each expert should also provide review in-light of the ## Design System section
of the specs/ui/index.spec.md - this is a Red Hat tool. All design system items
must be adhered to.

Agents should, if possible, use both Playwright and direct code reading to not only understand
the structure of the UI, but also the appearance and _feel_ of using the app.

1. Don Norman — Coined the term "User Experience," wrote The Design of Everyday Things. Co-founded Nielsen Norman Group. Still the most-cited voice arguing that technology must serve humans, not the reverse.
2. Edward Tufte — The defining figure in information visualization and visual display of quantitative data. His books (The Visual Display of Quantitative Information, Envisioning Information) established the principles for how data should be presented. The "data-ink ratio" concept is his.
3. Jakob Nielsen — Co-founded Nielsen Norman Group. His 10 usability heuristics (1994) remain the most widely used evaluation framework in UX. Currently pushing the question of whether those heuristics hold for generative/adaptive interfaces.
4. Steve Krug — Don't Make Me Think made usability accessible to non-specialists. His contribution was democratizing usability testing — proving you don't need a lab or a budget to get it right.
5. Alan Cooper — Created the concept of personas, which became the foundational tool for modeling user journeys. The Inmates Are Running the Asylum and About Face shaped a generation of interaction designers.
6. Jared Spool — Founded User Interface Engineering (UIE), one of the longest-running UX research firms. Prolific speaker and educator who has shaped how the industry thinks about design maturity in organizations.
7. Jesse James Garrett — Wrote The Elements of User Experience, which gave the field its canonical layer model (strategy → scope → structure → skeleton → surface). Also coined the term "Ajax" and founded Adaptive Path.
8. Indi Young — Pioneered empathy-driven design research. Mental Models and Practical Empathy shifted the field toward understanding the cognitive frameworks users bring, not just their clicks.
9. Erika Hall — Co-founded Mule Design. Just Enough Research pushed back on both "skip research" and "over-research" extremes. Known for sharp, contrarian thinking about what design owes to its users.
10. Julie Zhuo — Facebook's first intern to VP of Design over 14 years. The Making of a Manager bridged design and organizational leadership. Co-founded Sundial. Key voice on how design scales inside large product orgs.
11. Luke Wroblewski — Pioneered the "Mobile First" philosophy that reshaped how the entire industry approaches responsive design. Currently a Product Director at Google. Also wrote the definitive book on web form design.
12. Katie Dill — Led Experience Design at Airbnb (where design systems became a competitive advantage), then VP of Design at Lyft, now Head of Design at Stripe. Her career arc traces the evolution of design's role from feature-team craft to company-level strategy.
13. Golden Krishna — The Best Interface Is No Interface challenged the industry's assumption that every problem needs a screen. Head of Design Strategy at Google. Named one of Fast Company's "World's Best Designers."
14. Bret Victor — Former Apple designer, now at Dynamicland. His talks (Inventing on Principle, The Future of Programming) are among the most influential in the field. He pushes the boundary of what interactive visual media can be — arguing that the screen-based paradigm itself is the constraint.
15. Irene Au — Led UX at Google, Yahoo, and Udacity; now a Design Partner at Khosla Ventures where she advises startups on building design into their DNA from day one. Bridges the gap between design practice and venture-scale business thinking.

## Step 2: Apply Agent Feedback

Identify feedback that doesn't require a decision from a human, and apply it directly
using subagents. Parallelize where possible to maximize throughput and quality.

Surface any design decisions after kicking off the subagents.

After design decisions have been provided, proceed with implementation. 

FOR ANY AND ALL CHANGES, ensure that the relevant UI specs are updated, if needed.

Specs SHALL be the source of truth.

## Step 3: Loop to Step 1

Loop to step 1. Perform the loop 3 times, even if feedback becomes sparse.

## Step 4: Present for Review

Commit changes atomically, and present the result for review. 