// Registers and wires declared inside an if-generate block (as in serv_immdec).
module gen_top #(parameter W = 1) (
  input  logic       clk,
  input  logic       en,
  input  logic [3:0] d,
  output logic [3:0] q
);
  if (W == 1) begin : gen_w1
    logic [3:0] hold;
    logic [3:0] inv;
    assign inv = ~hold;
    always_ff @(posedge clk) if (en) hold <= d;
    assign q = inv;
  end
endmodule
