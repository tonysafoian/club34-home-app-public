-- Seed additional Club34 Ball roster invitees (imported June 2026).
--
-- Source: a dad-email spreadsheet provided by Tony ("K Dad Emails").
-- Adds 54 new players to ball_players for future-game email blasts.
-- Same convention as scripts/seed-ball-roster.sql: random 8-char URL-safe
-- tokens for /ball/p/:token personal RSVP links; active invitees, not host.
--
-- Idempotent: ON CONFLICT DO NOTHING (covers both the email and token
-- UNIQUE constraints). 2 email(s) from the list were already on the
-- roster and are intentionally omitted here.

INSERT INTO ball_players (name, email, token, active, is_host, notes) VALUES
  ('Robert Andrews',      'robbyj.andrews@gmail.com',        'm1jc55tt', true, false, NULL),
  ('Matthew Bair',        'yaymattski@gmail.com',            'dw3kgj2p', true, false, NULL),
  ('Lamar Baker',         'lamar.w.baker@gmail.com',         'rf1to6j4', true, false, NULL),
  ('Matthew Bash',        'thematthewbash@gmail.com',        '881ezjf1', true, false, NULL),
  ('Hanley Baxter',       'baxterh@gmail.com',               'y4kgeicr', true, false, NULL),
  ('Steven Broukhim',     'sbroukhim@gmail.com',             'ozt2s0qo', true, false, NULL),
  ('Andrew Clark',        'andrew.clark@lw.com',             'snkl8sqe', true, false, NULL),
  ('Macaulay Culkin',     'drixmix8@yahoo.com',              'fzl459rr', true, false, NULL),
  ('Mandla Daley',        'mandladaley@gmail.com',           'jc6r2in2', true, false, NULL),
  ('Maxwell David',       'mdavid@spearsarts.com',           '1guhak5u', true, false, NULL),
  ('Brian Davidian',      'briandavidian@gmail.com',         '1wtmt90a', true, false, NULL),
  ('Thomas Dawson',       'tcdawsonr@gmail.com',             'b0maupnm', true, false, NULL),
  ('James Demircift',     'jdemircift@gmail.com',            '7m1uid9l', true, false, NULL),
  ('Jason Donaldson',     'jasonrdonaldson@gmail.com',       'ppavmj29', true, false, NULL),
  ('Daniel Dubelman',     'ddubelman@gmail.com',             'anke0eqz', true, false, NULL),
  ('Lee Eisenberg',       'leejay1@gmail.com',               '68eczf4z', true, false, NULL),
  ('Michael Fitzgerald',  'michaeljohnfitzgerald@gmail.com',  'gohhrj7g', true, false, NULL),
  ('Daniel Fogelman',     'danfogelman@sbcglobal.net',       'lxu3end4', true, false, NULL),
  ('Tibor Forrai',        'tiborforaidds@gmail.com',         'nprl95cd', true, false, NULL),
  ('Alexander Frid',      'sfrid@millerbarondess.com',       'o45au2d9', true, false, NULL),
  ('David Glosman',       'davidglosman@gmail.com',          '0v40uzu3', true, false, NULL),
  ('David Gott',          'davegott@gmail.com',              'siqbr5z3', true, false, NULL),
  ('Zachary Greenberg',   'zach.greenberg32@gmail.com',      'ap8v8dme', true, false, NULL),
  ('Jon Haber',           'jhaber2000@gmail.com',            '3en1czae', true, false, NULL),
  ('Benjamin Harris',     'bharris88@gmail.com',             'haqm4fqa', true, false, NULL),
  ('Alex Henderson',      'alex.henderson@bobrick.com',      '2xy2d7rm', true, false, NULL),
  ('Matthew Henick',      'mhenick@gmail.com',               'tzy910cj', true, false, NULL),
  ('Jeffrey Horowitz',    'jeffhor@gmail.com',               'n5mbbx4b', true, false, NULL),
  ('Nicolas Jammet',      'nicolas@sweetgreen.com',          '4wjmdeuz', true, false, NULL),
  ('Joseph Janiak',       'joseph.janiak@gmail.com',         'n1xjv69f', true, false, NULL),
  ('Rami Kandela',        'rkandela@gmail.com',              'ae33rcul', true, false, NULL),
  ('Samuel Kang',         'kang.22.sam@gmail.com',           'qx5xrxrz', true, false, NULL),
  ('James Kim',           'jameskim1985@gmail.com',          'vbbvzqfi', true, false, NULL),
  ('Maxwell Koesler',     'maxkoesler@gmail.com',            'kvvzjv1k', true, false, NULL),
  ('Ilie Kramar',         'kramarmetals@sbcglobal.net',      'e4t3vs9g', true, false, NULL),
  ('Cody Leibel',         'codyleibel1@gmail.com',           '9nodjfcn', true, false, NULL),
  ('Ari Levin',           'alevin@caa.com',                  'uhqcaahc', true, false, NULL),
  ('Dayton Miller',       'daytonlmiller@gmail.com',         'uejm1zld', true, false, NULL),
  ('Nico Mizrahi',        'nmizrahi@gmail.com',              'pimbdrdc', true, false, NULL),
  ('Gurudeep Murthy',     'dee@ghst.io',                     'brwla299', true, false, NULL),
  ('Jay Patel',           'jaypatel14@gmail.com',            'fto7qp0i', true, false, NULL),
  ('Keith Pollock',       'kpollock@allenmatkins.com',       'gp1dwzrz', true, false, NULL),
  ('Varun Rachakonda',    'varun.rachakonda@gmail.com',      'f8ydh1wr', true, false, NULL),
  ('David Rebibo',        'drebibo@hw.com',                  '6opgz4rf', true, false, NULL),
  ('Tequan Richmond',     'tequanr@gmail.com',               'mdkz9kxa', true, false, NULL),
  ('Jason Rios',          'jasonrios22@gmail.com',           'avcqjage', true, false, NULL),
  ('Paras Shah',          'paras@gscinvestments.com',        'l8n4cudk', true, false, NULL),
  ('Matt Shreder',        'mshreder@gmail.com',              'ln5cvxe3', true, false, NULL),
  ('Louis Sterling',      'louis.sterling@gmail.com',        'ilcamsfw', true, false, NULL),
  ('Brandon Stewart',     'bhstewart81@gmail.com',           '91isj3sd', true, false, NULL),
  ('Vincent Szwajkowski',  'vszwajkowski@gmail.com',          '58ufcwe9', true, false, NULL),
  ('Ophir Tanz',          'ophir.tanz@gmail.com',            'cy2p16ie', true, false, NULL),
  ('Morgan Wandell',      'morgan.wandell@gmail.com',        'p9pbmyip', true, false, NULL),
  ('Jason Winer',         'jason@smalldogpictureco.com',     'qlntclof', true, false, NULL)
ON CONFLICT DO NOTHING;
