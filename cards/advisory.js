module.exports = {

    id:      'advisory',
    chip:    'Advisory',
    label:   'A security advisory',
    kind:    'signal',
    lede:    'severity',
    rules:   ['advisory-critical', 'advisory-high', 'advisory-medium', 'advisory-low'],
    summary: '{why}',
    wants:   ['advisory'],
    /*
     * Two first moves, and which one it is depends on whether a patch exists. Taking the patch was
     * offered unconditionally, including on the advisory whose own summary line reads "low
     * severity in elliptic, no patch yet" - and its prompt sends an agent to run my-dependabot-fix
     * and open a pull request for a version nobody has published. Where there is no patch the
     * decision is what to do instead, which is a different question and now a different button.
     */
    actions: [
      { label: 'Take the patch', verb: 'ask', when: 'patched', prompt: 'Use the my-dependabot-fix skill for {what}: take the patch, run what the change touches, and open the pull request.' },
      { label: 'What are the options?', verb: 'ask', when: 'unpatched', prompt: 'For {what}: there is no patched version yet. Tell me what this repository actually uses from the affected package, whether the vulnerable path is reachable from our code, and what the options are - pin, replace, vendor a fix, or wait.' },
      { label: 'Open the advisory', verb: 'url' },
      { verb: 'snooze', hours: 48 },
    ],
};
