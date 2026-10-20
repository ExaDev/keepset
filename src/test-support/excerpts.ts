/* The first lines of real files, one per layout the ratings parser reads, so the parser tests and the recipe tests read the same excerpts. */

/** ratings_Musical_Instruments.csv from the Amazon category files: user, product, rating, time; comma, no header, a decimal rating. */
export const AMAZON = "A1YS9MDZP93857,0006428320,3.0,1394496000\nA3TS466QBAWB9D,0014072149,5.0,1370476800\nA3BUDYITWUSIS7,0041291905,5.0,1381708800\nA19K10Z0D2NTZK,0041913574,5.0,1285200000\nA14X336IB4JD89,0201891859,1.0,1350432000\n";

/** u.data of ml-100k: tab-separated, no header. User 1 rates movie 1, which is the same number as the user. */
export const ML_100K = "196\t242\t3\t881250949\n186\t302\t3\t891717742\n22\t377\t1\t878887116\n1\t1\t5\t874965758\n";

/** ratings.dat of ml-1m and ml-10m: `::` between the fields, no header. */
export const ML_1M = "1::1193::5::978300760\n1::661::3::978302109\n1::914::3::978301968\n1::1::5::978824268\n";

/** ratings.csv of ml-25m: comma-separated with a header line, CRLF line endings and half-star ratings (the releases from ml-10m on have them). */
export const ML_25M = "userId,movieId,rating,timestamp\r\n1,296,5.0,1147880044\r\n1,306,3.5,1147868817\r\n1,307,5.0,1147868828\r\n1,665,5.0,1147878820\r\n";
