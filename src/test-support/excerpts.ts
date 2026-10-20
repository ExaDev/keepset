/* The first lines of real files, one per layout the ratings and KONECT parsers read, so the parser tests and the recipe tests read the same excerpts. Where a KONECT file has a second line declaring its edge count, the excerpt's line says the excerpt's own count, so that the excerpt is a file of its own and the count check has something to hold. */

/** ratings_Musical_Instruments.csv from the Amazon category files: user, product, rating, time; comma, no header, a decimal rating. */
export const AMAZON = "A1YS9MDZP93857,0006428320,3.0,1394496000\nA3TS466QBAWB9D,0014072149,5.0,1370476800\nA3BUDYITWUSIS7,0041291905,5.0,1381708800\nA19K10Z0D2NTZK,0041913574,5.0,1285200000\nA14X336IB4JD89,0201891859,1.0,1350432000\n";

/** u.data of ml-100k: tab-separated, no header. User 1 rates movie 1, which is the same number as the user. */
export const ML_100K = "196\t242\t3\t881250949\n186\t302\t3\t891717742\n22\t377\t1\t878887116\n1\t1\t5\t874965758\n";

/** ratings.dat of ml-1m and ml-10m: `::` between the fields, no header. */
export const ML_1M = "1::1193::5::978300760\n1::661::3::978302109\n1::914::3::978301968\n1::1::5::978824268\n";

/** ratings.csv of ml-25m: comma-separated with a header line, CRLF line endings and half-star ratings (the releases from ml-10m on have them). */
export const ML_25M = "userId,movieId,rating,timestamp\r\n1,296,5.0,1147880044\r\n1,306,3.5,1147868817\r\n1,307,5.0,1147868828\r\n1,665,5.0,1147878820\r\n";

/** out.moreno_lesmis_lesmis: an undirected network whose third column is a weight. */
export const LESMIS = "% sym posweighted\n% 6 77 77\n1 2 1\n2 3 8\n2 4 10\n2 5 1\n2 6 1\n2 7 1\n";

/** out.opsahl-collaboration: a bipartite network with no weights, each line ending in a space; left node 1 and right node 1 are different nodes. */
export const COLLABORATION = "% bip unweighted\n% 4 16726 22015\n1 1 \n1 2 \n1 3 \n1 4 \n";

/** out.opsahl-ucsocial: a directed network of messages; the third column is a repetition count of 1 and the fourth a time. */
export const UCSOCIAL = "% asym positive\n% 6 1899 1899\n1 2 1 1082008561\n3 4 1 1082123439\n5 2 1 1082381991\n6 7 1 1082407219\n8 7 1 1082407356\n9 10 1 1082408003\n";

/** out.radoslaw_email_email: as ucsocial, with two spaces between the second and third columns. */
export const RADOSLAW = "% asym positive\n% 4 167 167\n1 2  1 1262454010\n1 3  1 1262454010\n1 4  1 1262454010\n1 5  1 1262454010\n";

/** out.wikispeedia: a directed network with tab-separated pairs and no second line. */
export const WIKISPEEDIA = "% asym positive\n1\t2\n2\t3\n4\t5\n6\t7\n";
